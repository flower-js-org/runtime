/* Included after pinned upstream/quickjs.c. SPDX-License-Identifier: MIT */

typedef struct {
    JSValue object;
    JSValue value;
    JSAtom key;
} FlowerJsonGuard;

typedef struct {
    JSValue object;
    JSValue prototype;
} FlowerPrototypeGuard;

static FlowerJsonGuard flower_json_guards[32];
static unsigned flower_json_guard_count;
static FlowerPrototypeGuard flower_json_prototypes[8];
static unsigned flower_json_prototype_count;
static JSAtom flower_json_globals[6];
static JSValue flower_json_object_prototype;

/* Kept alive by the duplicated JSValues in our process-lifetime pristine image.
 * No guard evaluates accessors, proxy traps, or application code. */
static int flower_json_capture(JSContext *ctx, JSValueConst object, JSAtom key) {
    if (flower_json_guard_count == countof(flower_json_guards)) abort();
    JSValue value = JS_GetProperty(ctx, object, key);
    if (JS_IsException(value)) return -1;
    FlowerJsonGuard *guard = &flower_json_guards[flower_json_guard_count++];
    guard->object = JS_DupValue(ctx, object);
    guard->value = value;
    guard->key = JS_DupAtom(ctx, key);
    return 0;
}

static int flower_json_capture_name(JSContext *ctx, JSValueConst object, const char *name) {
    JSAtom key = JS_NewAtom(ctx, name);
    if (key == JS_ATOM_NULL) return -1;
    int result = flower_json_capture(ctx, object, key);
    JS_FreeAtom(ctx, key);
    return result;
}

static bool flower_json_same(JSValueConst first, JSValueConst second) {
    /* Every captured guard value is an object/function. */
    return JS_VALUE_GET_TAG(first) == JS_TAG_OBJECT
        && JS_VALUE_GET_TAG(second) == JS_TAG_OBJECT
        && JS_VALUE_GET_OBJ(first) == JS_VALUE_GET_OBJ(second);
}

static bool flower_json_intrinsics_unchanged(JSContext *ctx) {
    JSProperty *property;
    /* `let Set = ...` lives in a separate lexical environment, not globalThis.
     * Any such binding conservatively selects the full original JS validator. */
    JSObject *lexicals = JS_VALUE_GET_OBJ(ctx->global_var_obj);
    for (unsigned i = 0; i < countof(flower_json_globals); ++i)
        if (find_own_property(&property, lexicals, flower_json_globals[i])) return false;
    for (unsigned i = 0; i < flower_json_guard_count; ++i) {
        FlowerJsonGuard *guard = &flower_json_guards[i];
        JSShapeProperty *shape = find_own_property(&property,
            JS_VALUE_GET_OBJ(guard->object), guard->key);
        if (!shape || (shape->flags & JS_PROP_TMASK)
            || !flower_json_same(property->u.value, guard->value)) return false;
    }
    /* The old `"value" in descriptor` observes Object.prototype pollution. */
    if (find_own_property(&property, JS_VALUE_GET_OBJ(flower_json_object_prototype),
                         JS_ATOM_value)) return false;
    /* Reflect.ownKeys is consumed with for-of. Preserve monkeypatched iterator
     * closure behavior and inherited return hooks by falling back entirely. */
    for (unsigned i = 0; i < flower_json_prototype_count; ++i) {
        FlowerPrototypeGuard *guard = &flower_json_prototypes[i];
        JSObject *object = JS_VALUE_GET_OBJ(guard->object);
        if (object->shape->proto != (JS_IsNull(guard->prototype)
                                    ? NULL : JS_VALUE_GET_OBJ(guard->prototype))) return false;
        if (find_own_property(&property, object, JS_ATOM_return)) return false;
    }
    return true;
}

/* 1: valid; 0: run the untouched JS validator; -1: engine allocation failure.
 * Before a fallback we have performed no user-observable calls or mutations. */
static int flower_json_walk(JSContext *ctx, JSValueConst value,
                            JSObject **active, unsigned depth) {
    if (depth > 128) return 0;
    int tag = JS_VALUE_GET_NORM_TAG(value);
    switch (tag) {
    case JS_TAG_NULL:
    case JS_TAG_STRING:
    case JS_TAG_BOOL:
    case JS_TAG_INT:
        return 1;
    case JS_TAG_FLOAT64:
        return isfinite(JS_VALUE_GET_FLOAT64(value));
    case JS_TAG_OBJECT:
        break;
    default:
        return 0;
    }
    JSObject *object = JS_VALUE_GET_OBJ(value);
    if (JS_IsProxy(value) || JS_IsFunction(ctx, value)) return 0;
    for (unsigned i = 0; i < depth; ++i)
        if (active[i] == object) return 0;
    bool array = JS_IsArray(value);
    if (!array && object->shape->proto != NULL
        && object->shape->proto != JS_VALUE_GET_OBJ(flower_json_object_prototype)) return 0;
    active[depth] = object;

    /* Ordinary objects and dense arrays expose only their shape's own data
     * slots (plus the contiguous array elements). Inspect them without making
     * an own-key vector, retaining atoms, or duplicating property descriptors.
     * Walking shape order rather than Reflect.ownKeys order is unobservable:
     * no getter/trap runs, and any unsupported slot restarts the original JS
     * validator before it can report an error or call application code. */
    bool dense_array = array && object->fast_array;
    if ((!array && object->class_id == JS_CLASS_OBJECT && !object->is_exotic)
        || dense_array) {
        JSShape *shape = object->shape;
        JSShapeProperty *properties = get_shape_prop(shape);
        if (dense_array) {
            /* The pinned engine keeps length in slot zero. Fast elements are
             * present and enumerable data properties at every index < count;
             * extending length without elements is therefore a hole. Do not
             * interpret the union or assume density unless all guards hold. */
            if (shape->prop_count == 0 || properties[0].atom != JS_ATOM_length
                || (properties[0].flags & JS_PROP_TMASK)) return 0;
            JSValueConst length = object->prop[0].u.value;
            if (JS_VALUE_GET_TAG(length) != JS_TAG_INT
                || JS_VALUE_GET_INT(length) < 0
                || (uint32_t)JS_VALUE_GET_INT(length) != object->u.array.count) return 0;
            for (uint32_t i = 0; i < object->u.array.count; ++i) {
                int status = flower_json_walk(ctx, object->u.array.u.values[i],
                                              active, depth + 1);
                if (status != 1) return status;
            }
        }
        for (int i = 0; i < shape->prop_count; ++i) {
            JSShapeProperty *property = &properties[i];
            JSAtom key = property->atom;
            if (key == JS_ATOM_NULL || (array && key == JS_ATOM_length)) continue;
            if ((!__JS_AtomIsTaggedInt(key)
                 && ctx->rt->atom_array[key]->atom_type != JS_ATOM_TYPE_STRING)
                || !(property->flags & JS_PROP_ENUMERABLE)
                || (property->flags & JS_PROP_TMASK)) return 0;
            int status = flower_json_walk(ctx, object->prop[i].u.value,
                                          active, depth + 1);
            if (status != 1) return status;
        }
        return 1;
    }

    JSPropertyEnum *keys;
    uint32_t count;
    if (JS_GetOwnPropertyNames(ctx, &keys, &count, value,
                              JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0) return -1;
    int status = 1;
    for (uint32_t i = 0; i < count; ++i) {
        JSAtom key = keys[i].atom;
        if (array && key == JS_ATOM_length) continue;
        /* Symbols are rejected by the original validator. No descriptor traps
         * can run on the native path, so it is safe to fall back immediately. */
        if (!__JS_AtomIsTaggedInt(key)
            && ctx->rt->atom_array[key]->atom_type != JS_ATOM_TYPE_STRING) {
            status = 0;
            break;
        }
        JSPropertyDescriptor descriptor;
        int found = JS_GetOwnProperty(ctx, &descriptor, value, key);
        if (found <= 0) {
            status = found < 0 ? -1 : 0;
            break;
        }
        if (!(descriptor.flags & JS_PROP_ENUMERABLE) || descriptor.flags & JS_PROP_GETSET)
            status = 0;
        else
            status = flower_json_walk(ctx, descriptor.value, active, depth + 1);
        js_free_desc(ctx, &descriptor);
        if (status != 1) break;
    }
    JS_FreePropertyEnum(ctx, keys, count);
    if (status == 1 && array) {
        /* Array length is a non-configurable own numeric data property, so this
         * cannot invoke getters. Proxy arrays were routed to JS before this. */
        JSValue length_value = JS_GetProperty(ctx, value, JS_ATOM_length);
        uint32_t length;
        if (JS_ToUint32(ctx, &length, length_value) < 0) status = -1;
        JS_FreeValue(ctx, length_value);
        if (status != 1) return status;
        for (uint32_t i = 0; i < length; ++i) {
            JSAtom key = JS_NewAtomUInt32(ctx, i);
            if (key == JS_ATOM_NULL) return -1;
            int found = JS_GetOwnProperty(ctx, NULL, value, key);
            JS_FreeAtom(ctx, key);
            if (found <= 0) return found < 0 ? -1 : 0;
        }
    }
    return status;
}

static JSValue flower_json_check(JSContext *ctx, JSValueConst this_value,
                                 int argc, JSValueConst *argv) {
    (void)this_value;
    if (argc != 1 || !flower_json_intrinsics_unchanged(ctx)) return JS_FALSE;
    /* Each ancestor slot is set before recursion; unused slots are never read. */
    JSObject *active[129];
    int result = flower_json_walk(ctx, argv[0], active, 0);
    return result < 0 ? JS_EXCEPTION : JS_NewBool(ctx, result != 0);
}

int flower_json_init(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    const char *names[] = {"Set", "Object", "Array", "Number", "Reflect", "Error"};
    JSValue builtins[countof(names)];
    for (unsigned i = 0; i < countof(names); ++i) {
        flower_json_globals[i] = JS_NewAtom(ctx, names[i]);
        if (flower_json_globals[i] == JS_ATOM_NULL) return -1;
        if (flower_json_capture(ctx, global, flower_json_globals[i]) < 0) return -1;
        builtins[i] = JS_GetProperty(ctx, global, flower_json_globals[i]);
        if (JS_IsException(builtins[i])) return -1;
    }
    JSValue set_prototype = JS_GetPropertyStr(ctx, builtins[0], "prototype");
    flower_json_object_prototype = JS_GetPropertyStr(ctx, builtins[1], "prototype");
    JSValue array_prototype = JS_GetPropertyStr(ctx, builtins[2], "prototype");
    if (JS_IsException(set_prototype) || JS_IsException(flower_json_object_prototype)
        || JS_IsException(array_prototype)) return -1;
    for (unsigned i = 0; i < 3; ++i)
        if (flower_json_capture_name(ctx, builtins[i], "prototype") < 0) return -1;
    for (unsigned i = 0; i < 3; ++i)
        if (flower_json_capture_name(ctx, set_prototype, (const char *[]){"has", "add", "delete"}[i]) < 0) return -1;
    for (unsigned i = 0; i < 3; ++i)
        if (flower_json_capture_name(ctx, builtins[1], (const char *[]){"getPrototypeOf", "getOwnPropertyDescriptor", "hasOwn"}[i]) < 0) return -1;
    if (flower_json_capture_name(ctx, builtins[2], "isArray") < 0
        || flower_json_capture_name(ctx, builtins[3], "isFinite") < 0
        || flower_json_capture_name(ctx, builtins[4], "ownKeys") < 0
        || flower_json_capture(ctx, array_prototype, JS_ATOM_Symbol_iterator) < 0) return -1;
    JSValue empty = JS_NewArray(ctx);
    JSValue iterator = JS_Invoke(ctx, empty, JS_ATOM_Symbol_iterator, 0, NULL);
    JS_FreeValue(ctx, empty);
    if (JS_IsException(iterator)) return -1;
    JSValue prototype = JS_GetPrototype(ctx, iterator);
    JS_FreeValue(ctx, iterator);
    if (JS_IsException(prototype)) return -1;
    if (flower_json_capture_name(ctx, prototype, "next") < 0) return -1;
    while (!JS_IsNull(prototype)) {
        if (flower_json_prototype_count == countof(flower_json_prototypes)) abort();
        JSValue parent = JS_GetPrototype(ctx, prototype);
        if (JS_IsException(parent)) return -1;
        FlowerPrototypeGuard *guard = &flower_json_prototypes[flower_json_prototype_count++];
        guard->object = prototype;
        guard->prototype = JS_DupValue(ctx, parent);
        prototype = parent;
    }
    JS_FreeValue(ctx, prototype);
    JS_FreeValue(ctx, array_prototype);
    JS_FreeValue(ctx, set_prototype);
    for (unsigned i = 0; i < countof(builtins); ++i) JS_FreeValue(ctx, builtins[i]);
    JSValue function = JS_NewCFunction(ctx, flower_json_check, "__flowerCheckJson", 1);
    /* Trusted bootstrap captures this function and then removes the temporary
     * global. No reserved JS identifier or replaceable validator remains. */
    int result = JS_DefinePropertyValueStr(ctx, global, "__flowerCheckJson", function,
                                         JS_PROP_CONFIGURABLE);
    JS_FreeValue(ctx, global);
    return result < 0 ? -1 : 0;
}
