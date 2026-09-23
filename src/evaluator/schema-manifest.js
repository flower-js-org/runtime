(app) => {
    function data(value, label) {
        if (value === null || typeof value !== 'object' || Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
            throw new Error(label + ' must be a plain object');
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor))
                throw new Error(label + ' requires enumerable data properties');
        }
        return value;
    }
    function fields(value) {
        if (!Array.isArray(value) || value.length === 0 ||
            [...value].some(field => typeof field !== 'string' || !field) ||
            new Set(value).size !== value.length)
            throw new Error('Index fields must be distinct nonempty strings');
        return [...value];
    }
    const declarations = app.collections === undefined ? [] : app.collections;
    if (!Array.isArray(declarations)) throw new Error('collections must be an array');
    const indexes = [], aggregates = Object.create(null), collections = new Set(), identities = new Set();
    for (const raw of declarations) {
        const collection = data(raw, 'Collection declaration');
        if (Object.keys(collection).some(key => !['name', 'indexes'].includes(key)) ||
            typeof collection.name !== 'string' || !collection.name || collections.has(collection.name))
            throw new Error('Invalid or duplicate collection declaration');
        collections.add(collection.name);
        const declared = data(collection.indexes, 'Collection indexes');
        for (const name of Object.keys(declared)) {
            if (!name) throw new Error('Index names must be nonempty');
            const columns = fields(declared[name]);
            const identity = JSON.stringify([collection.name, columns]);
            if (!identities.has(identity)) {
                identities.add(identity);
                indexes.push({collection: collection.name, fields: columns});
            }
        }
    }
    for (const name of Object.keys(app.definitions)) {
        const definition = app.definitions[name];
        if (!Object.hasOwn(definition, 'aggregate')) continue;
        const metadata = data(definition.aggregate, 'Aggregate metadata');
        if (definition.kind !== 'derived' || Object.keys(metadata).some(key => !['collection', 'fields'].includes(key)) ||
            typeof metadata.collection !== 'string' || !metadata.collection)
            throw new Error('Aggregate metadata requires a derived definition, collection, and fields');
        const columns = fields(metadata.fields);
        if (!identities.has(JSON.stringify([metadata.collection, columns])))
            throw new Error('Aggregate index must be declared in define({collections})');
        aggregates[name] = {collection: metadata.collection, fields: columns};
    }
    return {indexes, aggregates};
}
