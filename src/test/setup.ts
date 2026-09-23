/**
 * Preloaded with `node --require` so that `import 'vscode'` in the modules under
 * test resolves to the mock instead of failing outside the extension host.
 */
import Module = require('module');

const mockPath = require.resolve('./vscode.mock');
const moduleInternals = Module as unknown as {
	_resolveFilename(request: string, ...rest: unknown[]): string;
};
const resolveFilename = moduleInternals._resolveFilename;

moduleInternals._resolveFilename = function (request: string, ...rest: unknown[]): string {
	if (request === 'vscode') {
		return mockPath;
	}
	return resolveFilename.call(this, request, ...rest);
};
