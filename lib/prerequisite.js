'use strict';
const execa = require('execa');
const Listr = require('listr');
const pTimeout = require('p-timeout');
const version = require('./version');

module.exports = (input, pkg, opts) => {
	let newVersion = null;
	let tagPrefix = 'v';
	const isExternalRegistry = typeof pkg.publishConfig === 'object' && typeof pkg.publishConfig.registry === 'string';

	const tasks = [
		{
			title: 'Ping npm registry',
			skip: () => pkg.private || isExternalRegistry,
			task: () => pTimeout(execa.stdout('npm', ['ping'])
				.catch(() => {
					throw new Error('Connection to npm registry failed');
				}), 15000, 'Connection to npm registry timed out')
		},
		{
			title: 'Verify user is authenticated',
			skip: () => process.env.NODE_ENV === 'test' || pkg.private || isExternalRegistry,
			task: () => execa.stdout('npm', ['whoami'])
				.catch(err => {
					throw new Error(/ENEEDAUTH/.test(err.stderr) ?
						'You must be logged in to publish packages. Use `npm login` and try again.' :
						'Authentication error. Use `npm whoami` to troubleshoot.');
				})
				// Check if user has write access to current package
				.then(username => execa.stdout('npm', ['access', 'ls-collaborators', pkg.name])
					.then(collaborators => {
						const json = JSON.parse(collaborators);
						const permissions = json[username];
						if (!permissions || !permissions.includes('write')) {
							throw new Error('You do not have write permissions required to publish this package.');
						}
					})
					.catch(() => { /* E404 can be safely ignored */ }))
		},
		{
			title: 'Check git remote',
			task: () => execa.stdout('git', ['ls-remote', 'origin', 'HEAD'])
				.catch(err => {
					throw new Error(err.stderr.replace('fatal:', 'Git fatal error:'));
				})
		},
		{
			title: 'Validate version',
			task: () => {
				if (!version.isValidVersionInput(input)) {
					throw new Error(`Version should be either ${version.SEMVER_INCREMENTS.join(', ')}, or a valid semver version.`);
				}

				newVersion = version.getNewVersion(pkg.version, input);

				if (!version.isVersionGreater(pkg.version, newVersion)) {
					throw new Error(`New version \`${newVersion}\` should be higher than current version \`${pkg.version}\``);
				}
			}
		},
		{
			title: 'Check for pre-release version',
			enabled: () => opts.publish,
			task: () => {
				if (!pkg.private && version.isPrereleaseVersion(newVersion) && !opts.tag) {
					throw new Error('You must specify a dist-tag using --tag when publishing a pre-release version. This prevents accidentally tagging unstable versions as "latest". https://docs.npmjs.com/cli/dist-tag');
				}
			}
		},
		{
			title: 'Check npm version',
			skip: () => version.isVersionLower('6.0.0', process.version),
			task: () => execa.stdout('npm', ['version', '--json']).then(json => {
				const versions = JSON.parse(json);
				if (!version.satisfies(versions.npm, '>=2.15.8 <3.0.0 || >=3.10.1')) {
					throw new Error(`npm@${versions.npm} has known issues publishing when running Node.js 6. Please upgrade npm or downgrade Node and publish again. https://github.com/npm/npm/issues/5082`);
				}
			})
		},
		{
			title: 'Check git tag existence',
			task: () => execa('git', ['fetch'])
				.then(() => {
					if (opts.yarn) {
						return execa.stdout('yarn', ['config', 'get', 'version-tag-prefix']);
					}
					return execa.stdout('npm', ['config', 'get', 'tag-version-prefix']);
				})
				.then(
					output => {
						tagPrefix = output;
					},
					() => {}
				)
				.then(() => execa.stdout('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tagPrefix}${newVersion}`]))
				.then(
					output => {
						if (output) {
							throw new Error(`Git tag \`${tagPrefix}${newVersion}\` already exists.`);
						}
					},
					err => {
						// Command fails with code 1 and no output if the tag does not exist, even though `--quiet` is provided
						// https://github.com/sindresorhus/np/pull/73#discussion_r72385685
						if (err.stdout !== '' || err.stderr !== '') {
							throw err;
						}
					}
				)
		}
	];

	return new Listr(tasks);
};
