// Node 22+ can bind `localStorage` as undefined unless --localstorage-file is set.
// jsdom's storage is then shadowed, which breaks app.js import-time theme bootstrap.
if (typeof globalThis.localStorage?.getItem !== "function") {
	const store = new Map();
	const memoryStorage = {
		getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
		setItem: (key, value) => {
			store.set(String(key), String(value));
		},
		removeItem: (key) => {
			store.delete(String(key));
		},
		clear: () => {
			store.clear();
		},
		key: (index) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: memoryStorage,
		writable: true,
		configurable: true,
	});
}
