/**
 * Programmatic entry for the git-colabor core library (consumed by the VS Code extension
 * build pipeline and by direct require()). The CLI is bundled separately as dist/cli.cjs.
 */
export * from './core/authors/types.js';
export * from './core/authors/store.js';
export * from './core/message/formatter.js';
export * from './core/message/template.js';
export * from './core/coauthors/state.js';
export * from './core/git/exec.js';
export * from './core/git/config.js';
export * from './core/git/rev.js';
export * from './core/git/shortlog.js';
export * from './core/logging/logger.js';
export * from './core/types.js';
export * from './core/errors.js';
