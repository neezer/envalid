const { cleanEnv } = require('..')
const { assert } = require('painless')

// Ensure that a given environment spec passes through all values from the given
// env object
exports.assertPassthrough = (env, spec) => {
    assert.deepEqual(cleanEnv(env, spec), Object.assign({}, { NODE_ENV: 'production' }, env))
}
