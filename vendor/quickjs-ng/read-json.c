/* Included after pinned upstream/quickjs.c and json-check.c.
 * SPDX-License-Identifier: MIT */
extern JSValue flower_read_parsed_host(JSContext *ctx, JSValueConst method,
                                       JSValueConst payload);

static FlowerJsonGuard flower_read_guards[4];
static JSAtom flower_read_globals[2];

/* Return undefined before any observable work if the original JS expression's
 * callees have changed. Its lexical bindings are resolved in the global env. */
static bool flower_read_unchanged(JSContext *ctx) {
    JSProperty *property;
    JSObject *lexicals = JS_VALUE_GET_OBJ(ctx->global_var_obj);
    for (unsigned i = 0; i < countof(flower_read_globals); ++i)
        if (find_own_property(&property, lexicals, flower_read_globals[i])) return false;
    for (unsigned i = 0; i < countof(flower_read_guards); ++i) {
        FlowerJsonGuard *guard = &flower_read_guards[i];
        JSShapeProperty *shape = find_own_property(&property,
            JS_VALUE_GET_OBJ(guard->object), guard->key);
        if (!shape || (shape->flags & JS_PROP_TMASK)
            || !flower_json_same(property->u.value, guard->value)) return false;
    }
    return true;
}

static JSValue flower_read_parsed(JSContext *ctx, JSValueConst this_value,
                                  int argc, JSValueConst *argv) {
    (void)this_value;
    if (argc != 2 || !flower_read_unchanged(ctx)) return JS_UNDEFINED;
    /* Match JSON.parse(__flowerRead(method, JSON.stringify(args))): all three
     * functions are resolved before stringify can run a toJSON/proxy hook.
     * Use the exact intrinsic, not a custom encoder, preserving those effects.
     * Stringification still precedes method conversion just as in the JS
     * call expression; CString ownership remains inside the existing bridge. */
    JSValue payload = JS_JSONStringify(ctx, argv[1], JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(payload)) return payload;
    JSValue result = flower_read_parsed_host(ctx, argv[0], payload);
    JS_FreeValue(ctx, payload);
    return result;
}

int flower_read_init(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue json = JS_GetPropertyStr(ctx, global, "JSON");
    if (JS_IsException(json)) { JS_FreeValue(ctx, global); return -1; }
    const char *names[] = {"JSON", "stringify", "parse", "__flowerRead"};
    for (unsigned i = 0; i < countof(flower_read_guards); ++i) {
        FlowerJsonGuard *guard = &flower_read_guards[i];
        guard->key = JS_NewAtom(ctx, names[i]);
        if (guard->key == JS_ATOM_NULL) return -1;
        guard->object = JS_DupValue(ctx, i == 0 || i == 3 ? global : json);
        guard->value = JS_GetProperty(ctx, guard->object, guard->key);
        if (JS_IsException(guard->value)) return -1;
    }
    flower_read_globals[0] = JS_DupAtom(ctx, flower_read_guards[0].key);
    flower_read_globals[1] = JS_DupAtom(ctx, flower_read_guards[3].key);
    JS_FreeValue(ctx, json);
    int result = JS_DefinePropertyValueStr(ctx, global, "__flowerReadParsed",
        JS_NewCFunction(ctx, flower_read_parsed, "__flowerReadParsed", 2), JS_PROP_CONFIGURABLE);
    JS_FreeValue(ctx, global);
    return result < 0 ? -1 : 0;
}
