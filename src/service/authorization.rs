//! Code-owned admission runs independently of business execution and receipt
//! replay. Credentials never become part of the durable business fingerprint.
use super::*;
use serde::Serialize;
use serde::ser::SerializeMap;
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

pub(super) fn required(state: &Snapshot) -> bool {
    state
        .data
        .get("authorizationMethod")
        .is_some_and(|value| !value.is_null())
}

fn denied(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "FORBIDDEN", message.into())
}

pub(super) async fn authorize_admitted(
    app: &App,
    state: &Snapshot,
    input: &Value,
    permit: &admission::Permit,
) -> Result<Value, ApiError> {
    Ok(authorize_inner(app, state, input, Value::Null, permit).await?.0)
}

/// Also says how long the decision holds without a new revision, so an idle
/// watch rechecks access exactly when a token expires rather than on a timer.
pub(super) async fn authorize_watch(
    app: &App,
    state: &Snapshot,
    input: &Value,
    permit: &admission::Permit,
) -> Result<(Value, Validity), ApiError> {
    authorize_inner(app, state, input, Value::Null, permit).await
}

pub(super) async fn authorize_delegated_admitted(
    app: &App,
    state: &Snapshot,
    input: &Value,
    delegation: Value,
    permit: &admission::Permit,
) -> Result<Value, ApiError> {
    Ok(authorize_inner(app, state, input, delegation, permit).await?.0)
}

async fn authorize_inner(
    app: &App,
    state: &Snapshot,
    input: &Value,
    delegation: Value,
    admission: &admission::Permit,
) -> Result<(Value, Validity), ApiError> {
    let Some(method) = state
        .data
        .get("authorizationMethod")
        .filter(|value| !value.is_null())
    else {
        return Ok((
            delegation.get("principal").cloned().unwrap_or(Value::Null),
            Validity::Stable,
        ));
    };
    let name = method["name"]
        .as_str()
        .ok_or_else(|| denied("Invalid authorization method"))?;
    let partition = app
        .consensus
        .partition_binding()
        .map(|binding| binding.partition.as_str());
    let invocation = json!({"name":name,"args":{
        "credentials": input.get("credentials").unwrap_or(&Value::Null),
        "method": input["name"],
        "args": input.get("args").unwrap_or(&Value::Null),
        "partition": partition,
        "delegation": delegation,
    }});
    let data = state.data.clone();
    let now = app.clock.sample(state).map_err(unavailable)?;
    let permit = app
        .query_evaluations
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| unavailable(error.into()))?;
    let admission = admission.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _admission = admission;
        let _permit = permit;
        evaluator::invoke_at(data, invocation, "query", now)
    })
    .await
    .map_err(|error| unavailable(error.into()))?
    .map_err(|error| match engine_failure(&error) {
        Some(failure) => denied("Authorization denied").with_failure(failure),
        None => denied("Authorization denied"),
    })?;
    let validity = Validity::of(&result);
    let principal = result.value;
    let Some(object) = principal.as_object() else {
        return Err(denied("Authorization denied"));
    };
    if object
        .keys()
        .any(|key| !["subject", "tenant", "claims"].contains(&key.as_str()))
        || !principal["subject"]
            .as_str()
            .is_some_and(|subject| !subject.is_empty())
        || object
            .get("tenant")
            .is_some_and(|tenant| !tenant.as_str().is_some_and(|value| !value.is_empty()))
    {
        return Err(denied("Authorization returned an invalid principal"));
    }
    if let Some(partition) = partition
        && principal["tenant"].as_str() != Some(partition)
    {
        return Err(denied("Principal is not authorized for this partition"));
    }
    Ok((principal, validity))
}

pub(super) fn business_input(input: &Value) -> Value {
    let mut value = input.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("credentials");
        // Deployment preparation strategy is scheduling, not logical intent.
        object.remove("preparation");
    }
    value
}

pub(super) fn owner(principal: &Value, operator: bool) -> String {
    crate::consensus::retention::owner_for(
        &serde_json::to_string(&if operator {
            json!(["operator"])
        } else {
            json!(["application", principal["subject"], principal["tenant"]])
        })
        .expect("owner JSON"),
    )
}

pub(super) fn fingerprint(input: &Value, deployment: bool, principal: &Value) -> String {
    let value = Intent {
        deployment,
        // Claims may change as tokens refresh; only the stable subject and
        // tenant own the historical outcome. Null still omits owner entirely.
        owner: (!principal.is_null()).then(|| IntentOwner {
            subject: &principal["subject"],
            tenant: &principal["tenant"],
        }),
        request: BusinessInput(input),
    };
    let mut digest = FingerprintWriter(Sha256::new());
    serde_json::to_writer(&mut digest, &value).expect("JSON fingerprint");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in digest.0.finalize() {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 15) as usize] as char);
    }
    encoded
}

// Field order matches the old serde_json::Value object's sorted keys exactly.
// Borrowing and streaming avoid cloning the request/claims and allocating a
// throwaway JSON buffer for every admitted mutation or retry.
#[derive(Serialize)]
struct Intent<'a> {
    deployment: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<IntentOwner<'a>>,
    request: BusinessInput<'a>,
}

#[derive(Serialize)]
struct IntentOwner<'a> {
    subject: &'a Value,
    tenant: &'a Value,
}

struct BusinessInput<'a>(&'a Value);

impl Serialize for BusinessInput<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Some(object) = self.0.as_object() else {
            return self.0.serialize(serializer);
        };
        let count = object.len()
            - usize::from(object.contains_key("credentials"))
            - usize::from(object.contains_key("preparation"));
        let mut map = serializer.serialize_map(Some(count))?;
        for (key, value) in object {
            if key != "credentials" && key != "preparation" {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

struct FingerprintWriter(Sha256);

impl std::io::Write for FingerprintWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.0.update(bytes);
        Ok(())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
