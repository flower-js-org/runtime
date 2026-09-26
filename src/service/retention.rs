//! Retry identity metadata and operator-controlled replicated retirement.
use super::*;
use crate::consensus::retention as protocol;

pub(super) fn error(error: anyhow::Error) -> ApiError {
    let message = error.to_string();
    let code = message.split(':').next().unwrap_or_default();
    let code = match code {
        "RETRY_WINDOW_EXPIRED" => "RETRY_WINDOW_EXPIRED",
        "HISTORY_MISMATCH" => "HISTORY_MISMATCH",
        "REQUEST_DATABASE_MISMATCH" => "REQUEST_DATABASE_MISMATCH",
        "REQUEST_ID_SCOPE_REQUIRED" => "REQUEST_ID_SCOPE_REQUIRED",
        "REQUEST_ID_INVALID" => "REQUEST_ID_INVALID",
        "RETRY_EPOCH_NOT_ADMITTED" => "RETRY_EPOCH_NOT_ADMITTED",
        "RETENTION_NOT_INITIALIZED" => "RETENTION_NOT_INITIALIZED",
        "RECEIPT_BUDGET_EXCEEDED" => "RECEIPT_BUDGET_EXCEEDED",
        "ALREADY_ACKNOWLEDGED" => "ALREADY_ACKNOWLEDGED",
        "RETRY_SESSION_CLOSED" => "RETRY_SESSION_CLOSED",
        "RETRY_SESSION_UNKNOWN" => "RETRY_SESSION_UNKNOWN",
        "RETRY_SESSION_MISMATCH" => "RETRY_SESSION_MISMATCH",
        "RETRY_SESSION_FORBIDDEN" => "RETRY_SESSION_FORBIDDEN",
        "RETRY_SESSION_EXISTS" => "RETRY_SESSION_EXISTS",
        "RETRY_ACK_GAP" => "RETRY_ACK_GAP",
        "RETRY_ACK_BUDGET" => "RETRY_ACK_BUDGET",
        "RETENTION_TRANSACTION_ACTIVE" => "RETENTION_TRANSACTION_ACTIVE",
        _ => "RETENTION_CONFLICT",
    };
    ApiError::new(StatusCode::CONFLICT, code, message)
}

pub(super) fn validate_session(input: &Value) -> Result<(), ApiError> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid(anyhow::anyhow!("session request must be an object")))?;
    if object.keys().any(|key| {
        ![
            "operation",
            "session",
            "incarnation",
            "epoch",
            "through",
            "limit",
            "abandon",
            "credentials",
        ]
        .contains(&key.as_str())
    }) || !matches!(
        input["operation"].as_str(),
        Some("open" | "ack" | "close" | "status")
    ) {
        return Err(invalid(anyhow::anyhow!(
            "invalid session operation or field"
        )));
    }
    if !input["session"].as_str().is_some_and(|id| {
        id.len() == 32
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }) || !input["incarnation"].is_string()
    {
        return Err(invalid(anyhow::anyhow!(
            "session requires a 32-character lowercase hex ID and incarnation"
        )));
    }
    Ok(())
}

pub(super) async fn session_handle(
    State(app): State<Arc<App>>,
    Json(input): Json<Value>,
) -> Result<Response, ApiError> {
    validate_session(&input)?;
    forwarding::commit_session(app, input).await
}

pub(super) async fn session_commit(app: Arc<App>, input: Value) -> Result<Value, ApiError> {
    validate_session(&input)?;
    if let Some(gate) = &app.partition_gate {
        gate.check().await?;
    }
    let _input = app
        .admission
        .retain(admission::Class::User, admission::input_bytes(&input))?;
    let _writer = app.writer.lock().await;
    let admission = admission::acquire_retained(&app, admission::Class::User).await?;
    let snapshot = app.consensus.read_for_writer().await.map_err(unavailable)?;
    if !authorization::required(&snapshot) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "retry sessions require a deployed authorization hook".into(),
        ));
    }
    let authorization_input = json!({"name":format!("$flower.session.{}",input["operation"].as_str().unwrap()),
        "args":authorization::business_input(&input),"credentials":input["credentials"]});
    let principal =
        authorization::authorize_admitted(&app, &snapshot, &authorization_input, &admission)
            .await?;
    let owner = authorization::owner(&principal, false);
    let state = protocol::status(&snapshot).map_err(error)?.ok_or_else(|| {
        error(anyhow::anyhow!(
            "RETENTION_NOT_INITIALIZED: initialize retention first"
        ))
    })?;
    let incarnation = input["incarnation"].as_str().unwrap().to_owned();
    if incarnation != state.incarnation {
        return Err(error(anyhow::anyhow!(
            "HISTORY_MISMATCH: session belongs to another history"
        )));
    }
    let id = input["session"].as_str().unwrap().to_owned();
    let existing = protocol::session(&snapshot, &id).map_err(error)?;
    if let Some(session) = &existing {
        if session.incarnation != state.incarnation {
            return Err(error(anyhow::anyhow!(
                "HISTORY_MISMATCH: session belongs to another history"
            )));
        }
        if session.owner != owner {
            return Err(error(anyhow::anyhow!(
                "RETRY_SESSION_FORBIDDEN: session belongs to another principal"
            )));
        }
        if session.epoch < state.min_epoch {
            return Err(error(anyhow::anyhow!(
                "RETRY_WINDOW_EXPIRED: session epoch was retired"
            )));
        }
    }
    let response = |session: protocol::Session, revision| {
        json!({"revision":revision,"value":{
            "database":state.database,"incarnation":session.incarnation,"id":session.id,"epoch":session.epoch,
            "acknowledgedThrough":session.acknowledged_through,"closed":session.closed,
        }})
    };
    let operation = input["operation"].as_str().unwrap();
    if operation == "status" {
        return existing
            .map(|session| response(session, snapshot.revision))
            .ok_or_else(|| {
                error(anyhow::anyhow!(
                    "RETRY_SESSION_UNKNOWN: session does not exist"
                ))
            });
    }
    let safe = |name: &str| {
        input[name]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| invalid(anyhow::anyhow!("{name} must be a nonnegative safe integer")))
    };
    let action = match operation {
        "open" => {
            let epoch = safe("epoch")?;
            if let Some(session) = existing {
                if session.epoch != epoch || session.closed {
                    return Err(error(anyhow::anyhow!(
                        "RETRY_SESSION_CLOSED: session identity cannot be reopened"
                    )));
                }
                return Ok(response(session, snapshot.revision));
            }
            protocol::Action::OpenSession {
                incarnation,
                session: id,
                owner,
                epoch,
            }
        }
        "ack" => {
            let limit = usize::try_from(safe("limit")?).map_err(|e| invalid(e.into()))?;
            let abandon = match input.get("abandon") {
                None => false,
                Some(Value::Bool(value)) => *value,
                _ => return Err(invalid(anyhow::anyhow!("abandon must be boolean"))),
            };
            protocol::Action::Acknowledge {
                incarnation,
                session: id,
                owner,
                through: safe("through")?,
                limit,
                abandon,
            }
        }
        "close" => protocol::Action::CloseSession {
            incarnation,
            session: id,
            owner,
            limit: usize::try_from(safe("limit")?).map_err(|e| invalid(e.into()))?,
        },
        _ => unreachable!(),
    };
    let committed = app
        .consensus
        .control_retention(protocol::Command {
            expected_revision: snapshot.revision,
            action,
        })
        .await
        .map_err(error)?;
    let session = serde_json::from_value(committed.result["session"].clone())
        .map_err(|e| unavailable(e.into()))?;
    Ok(response(session, committed.revision))
}

pub(super) async fn identity(State(app): State<Arc<App>>) -> Result<Json<Value>, ApiError> {
    if let Some(gate) = &app.partition_gate {
        gate.check().await?;
    }
    let _admission = admission::acquire(&app, admission::Class::User, &Value::Null).await?;
    let state = app.consensus.read_query().await.map_err(unavailable)?;
    let status = protocol::status(&state).map_err(error)?;
    Ok(Json(
        json!({"revision":state.revision,"value":status.map(|s|json!({
            "database":s.database,"incarnation":s.incarnation,
            "currentEpoch":s.current_epoch,"minEpoch":s.min_epoch,
        }))}),
    ))
}

pub(super) async fn handle(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Response, ApiError> {
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(format!("Bearer {}", app.admin_token).as_str())
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "operator bearer token required".into(),
        ));
    }
    validate(&input)?;
    forwarding::commit_retention(app, input).await
}

pub(super) fn validate(input: &Value) -> Result<(), ApiError> {
    if input == &json!({"operation":"status"}) {
        return Ok(());
    }
    serde_json::from_value::<protocol::Command>(input.clone()).map_err(|e| invalid(e.into()))?;
    Ok(())
}

pub(super) async fn commit(app: Arc<App>, input: Value) -> Result<Value, ApiError> {
    validate(&input)?;
    if let Some(gate) = &app.partition_gate {
        gate.check().await?;
    }
    let _input = app
        .admission
        .retain(admission::Class::Control, admission::input_bytes(&input))?;
    let _writer = app.writer.lock().await;
    let _admission = admission::acquire_retained(&app, admission::Class::Control).await?;
    let state = app.consensus.read_for_writer().await.map_err(unavailable)?;
    if input["operation"] == "status" {
        return Ok(
            json!({"revision":state.revision,"value":protocol::status(&state).map_err(error)?}),
        );
    }
    let command = serde_json::from_value(input).map_err(|e| invalid(e.into()))?;
    let committed = app
        .consensus
        .control_retention(command)
        .await
        .map_err(error)?;
    Ok(
        json!({"revision":committed.revision,"value":committed.result,"duplicate":committed.duplicate}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writer_waiters_retain_bytes_without_occupying_worker_slots() {
        let (_directory,app)=super::super::tests::application(r#"
            const records={kind:'collection',name:'records'};
            var __flowerBundle={default:{definitions:{stable:{kind:'derived',name:'stable',compute:ctx=>ctx.get(records,'value')}},http:{}}};
        "#.into()).await;
        let writer = app.writer.lock().await;
        let mut session = Box::pin(session_commit(
            app.clone(),
            json!({
                "operation":"status","session":"0".repeat(32),"incarnation":"history"
            }),
        ));
        let mut control = Box::pin(commit(app.clone(), json!({"operation":"status"})));
        assert!(futures_util::poll!(&mut session).is_pending());
        assert!(futures_util::poll!(&mut control).is_pending());
        let metrics = app.admission.metrics();
        for class in metrics["classes"].as_array().unwrap() {
            assert_eq!(
                class["active"], 0,
                "writer waiters must not prevent the owner from admitting its next callback"
            );
            assert!(class["retainedInputBytes"].as_u64().unwrap() > 0);
        }
        drop(session);
        drop(control);
        for class in app.admission.metrics()["classes"].as_array().unwrap() {
            assert_eq!(class["retainedInputBytes"], 0);
        }
        drop(writer);
        app.consensus.shutdown().await.unwrap();
    }
}
