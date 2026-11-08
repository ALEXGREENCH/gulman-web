// Resolve the project's self-hosted browser import map for Node's test runner.
// node --experimental-loader ./tests/vendor-loader.mjs --test tests/*.test.mjs
const vendorRoot = new URL('../vendor/', import.meta.url);
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: new URL('three.module.js', vendorRoot).href, shortCircuit: true };
  if (specifier.startsWith('three/addons/')) {
    return { url: new URL(`addons/${specifier.slice(13)}`, vendorRoot).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
