/* Included after pinned upstream/quickjs.c and json-check.c.
 * SPDX-License-Identifier: MIT */

static FlowerJsonGuard flower_canonical_guards[7];
static unsigned flower_canonical_guard_count;
static JSAtom flower_canonical_globals[2];

static int flower_canonical_capture(JSContext *ctx, JSValueConst object,
                                     const char *name) {
    if (flower_canonical_guard_count == countof(flower_canonical_guards)) abort();
    JSAtom key = JS_NewAtom(ctx, name);
    if (key == JS_ATOM_NULL) return -1;
    JSValue value = JS_GetProperty(ctx, object, key);
    if (JS_IsException(value)) {
        JS_FreeAtom(ctx, key);
        return -1;
    }
    FlowerJsonGuard *guard = &flower_canonical_guards[flower_canonical_guard_count++];
    guard->object = JS_DupValue(ctx, object);
    guard->value = value;
    guard->key = key;
    return 0;
}

static bool flower_canonical_intrinsics_unchanged(JSContext *ctx, bool array) {
    JSProperty *property;
    JSObject *lexicals = JS_VALUE_GET_OBJ(ctx->global_var_obj);
    for (unsigned i = 0; i < countof(flower_canonical_globals); ++i)
        if (find_own_property(&property, lexicals, flower_canonical_globals[i])) return false;
    /* Scalars use only JSON.stringify and Number.isFinite. Arrays additionally
     * use the descriptor/iterator intrinsics guarded by the JSON validator. */
    unsigned count = array ? flower_canonical_guard_count : 4;
    for (unsigned i = 0; i < count; ++i) {
        FlowerJsonGuard *guard = &flower_canonical_guards[i];
        JSShapeProperty *shape = find_own_property(&property,
            JS_VALUE_GET_OBJ(guard->object), guard->key);
        if (!shape || (shape->flags & JS_PROP_TMASK)
            || !flower_json_same(property->u.value, guard->value)) return false;
    }
    return !array || flower_json_intrinsics_unchanged(ctx);
}

static bool flower_canonical_scalar(JSValueConst value) {
    switch (JS_VALUE_GET_NORM_TAG(value)) {
    case JS_TAG_NULL:
    case JS_TAG_BOOL:
    case JS_TAG_INT:
    case JS_TAG_STRING:
    case JS_TAG_STRING_ROPE:
        return true;
    case JS_TAG_FLOAT64:
        return isfinite(JS_VALUE_GET_FLOAT64(value));
    default:
        return false;
    }
}

/* A string is a complete encoding; undefined means run the original SDK code.
 * All eligibility and intrinsic checks are raw slot reads. Fallback therefore
 * cannot run a getter, proxy trap, iterator, toJSON hook, or user conversion. */
static JSValue flower_canonical_json(JSContext *ctx, JSValueConst this_value,
                                     int argc, JSValueConst *argv) {
    (void)this_value;
    if (argc != 1) return JS_UNDEFINED;
    JSValueConst value = argv[0];
    if (flower_canonical_scalar(value)) {
        if (!flower_canonical_intrinsics_unchanged(ctx, false)) return JS_UNDEFINED;
        int tag = JS_VALUE_GET_NORM_TAG(value);
        return tag == JS_TAG_STRING || tag == JS_TAG_STRING_ROPE
            ? JS_ToQuotedString(ctx, value) : JS_ToString(ctx, value);
    }
    if (JS_VALUE_GET_TAG(value) != JS_TAG_OBJECT) return JS_UNDEFINED;
    JSObject *object = JS_VALUE_GET_OBJ(value);
    if (object->class_id != JS_CLASS_ARRAY || !object->fast_array) return JS_UNDEFINED;
    JSShape *shape = object->shape;
    JSShapeProperty *properties = get_shape_prop(shape);
    if (shape->prop_count == 0 || properties[0].atom != JS_ATOM_length
        || (properties[0].flags & JS_PROP_TMASK)) return JS_UNDEFINED;
    JSValueConst length = object->prop[0].u.value;
    if (JS_VALUE_GET_TAG(length) != JS_TAG_INT || JS_VALUE_GET_INT(length) < 0
        || (uint32_t)JS_VALUE_GET_INT(length) != object->u.array.count) return JS_UNDEFINED;
    /* Fast elements are contiguous enumerable data slots. Every other live
     * shape slot would be a named property or symbol rejected by the SDK. */
    for (int i = 1; i < shape->prop_count; ++i)
        if (properties[i].atom != JS_ATOM_NULL) return JS_UNDEFINED;
    for (uint32_t i = 0; i < object->u.array.count; ++i)
        if (!flower_canonical_scalar(object->u.array.u.values[i])) return JS_UNDEFINED;
    if (!flower_canonical_intrinsics_unchanged(ctx, true)) return JS_UNDEFINED;

    StringBuffer buffer;
    if (string_buffer_init(ctx, &buffer, 64)) return JS_EXCEPTION;
    JSONStringifyContext stringify = { .b = &buffer };
    string_buffer_putc8(&buffer, '[');
    for (uint32_t i = 0; i < object->u.array.count; ++i) {
        if (i) string_buffer_putc8(&buffer, ',');
        /* Use the pinned engine's primitive JSON emitter: identical number
         * spelling, negative zero and well-formed UTF-16/surrogate escaping.
         * No whole-array stringify means inherited toJSON stays unobserved. */
        if (js_json_to_str(ctx, &stringify, JS_UNDEFINED,
                           JS_DupValue(ctx, object->u.array.u.values[i]), JS_UNDEFINED)) {
            string_buffer_free(&buffer);
            return JS_EXCEPTION;
        }
    }
    string_buffer_putc8(&buffer, ']');
    return string_buffer_end(&buffer);
}

int flower_canonical_init(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue json = JS_GetPropertyStr(ctx, global, "JSON");
    JSValue number = JS_GetPropertyStr(ctx, global, "Number");
    JSValue object = JS_GetPropertyStr(ctx, global, "Object");
    if (JS_IsException(json) || JS_IsException(number) || JS_IsException(object)) return -1;
    for (unsigned i = 0; i < countof(flower_canonical_globals); ++i) {
        flower_canonical_globals[i] = JS_NewAtom(ctx, (const char *[]){"JSON", "Number"}[i]);
        if (flower_canonical_globals[i] == JS_ATOM_NULL) return -1;
    }
    if (flower_canonical_capture(ctx, global, "JSON") < 0
        || flower_canonical_capture(ctx, json, "stringify") < 0
        || flower_canonical_capture(ctx, global, "Number") < 0
        || flower_canonical_capture(ctx, number, "isFinite") < 0
        || flower_canonical_capture(ctx, object, "create") < 0
        || flower_canonical_capture(ctx, ctx->class_proto[JS_CLASS_REGEXP], "test") < 0
        || flower_canonical_capture(ctx, ctx->class_proto[JS_CLASS_REGEXP], "exec") < 0) return -1;
    JS_FreeValue(ctx, json);
    JS_FreeValue(ctx, number);
    JS_FreeValue(ctx, object);
    /* Permanent SDK capability, installed before application code. Unlike the
     * temporary runner setup API this is intentionally callable by the SDK;
     * a nonconfigurable, nonwritable binding cannot be replaced or shadowed by
     * a later global lexical declaration. */
    int result = JS_DefinePropertyValueStr(ctx, global, "__flowerCanonicalJson",
        JS_NewCFunction(ctx, flower_canonical_json, "__flowerCanonicalJson", 1), 0);
    JS_FreeValue(ctx, global);
    return result < 0 ? -1 : 0;
}
