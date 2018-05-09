const {
    EnvError,
    EnvMissingError,
    makeValidator,
    bool,
    num,
    str,
    json,
    url,
    email,
    host,
    port
} = require('./lib/validators')

const extend = (x = {}, y = {}) => Object.assign({}, x, y)

const testOnlySymbol = Symbol('envalid - test only')

/**
* Validate a single env var, given a spec object
*
* @throws EnvError - If validation is unsuccessful
* @return - The cleaned value
*/
function validateVar({ spec = {}, name, rawValue }) {
    if (typeof spec._parse !== 'function') {
        throw new EnvError(`Invalid spec for "${name}"`)
    }
    const value = spec._parse(rawValue)

    if (spec.choices) {
        if (!Array.isArray(spec.choices)) {
            throw new TypeError(`"choices" must be an array (in spec for "${name}")`)
        } else if (!spec.choices.includes(value)) {
            throw new EnvError(`Value "${value}" not in choices [${spec.choices}]`)
        }
    }
    if (value == null) throw new EnvError(`Invalid value for env var "${name}"`)
    return value
}

// Format a string error message for when a required env var is missing
function formatSpecDescription(spec) {
    const egText = spec.example ? ` (eg. "${spec.example}")` : ''
    const docsText = spec.docs ? `. See ${spec.docs}` : ''
    return `${spec.desc}${egText}${docsText}` || ''
}

// Extend an env var object with the values parsed from a ".env"
// file, whose path is given by the second argument.
function extendWithDotEnv(inputEnv, dotEnvPath = '.env') {
    // fs and dotenv cannot be required inside react-native.
    // The react-native packager detects the require calls even if they
    // are not on the top level, so we need to obfuscate them
    const _require = require
    const fs = _require('fs')
    const dotenv = _require('dotenv')

    let dotEnvBuffer = null
    try {
        dotEnvBuffer = fs.readFileSync(dotEnvPath)
    } catch (err) {
        if (err.code === 'ENOENT') return inputEnv
        throw err
    }
    const parsed = dotenv.parse(dotEnvBuffer)
    return extend(parsed, inputEnv)
}

/**
 * Returns the input environment object, which is either loaded from a .env file
 * if options.dotEnvPath is set or provided as the first argument to cleanEnv
 * 
 * @see cleanEnv
 */
function getEnv({ inputEnv, options }) {
    let env = inputEnv

    if (options.dotEnvPath !== null) {
        env = extendWithDotEnv(inputEnv, options.dotEnvPath)
    }

    if (!env.NODE_ENV || env.NODE_ENV === '') {
        delete env.NODE_ENV
    }

    return env
}

/**
 * Returns a devDefault value for a spec object.
 */
function getDevDefault({ spec, env }) {
    const isNotProd = env.NODE_ENV !== 'production'
    const hasDevDefault = spec.hasOwnProperty('devDefault')

    return hasDevDefault && isNotProd ? spec.devDefault : undefined
}

/**
 * Returns a raw value from the input env. Will return a devDefault value if
 * appropriate.
 */
function getRawValue({ spec, env, specKey }) {
    const devDefault = getDevDefault({ spec, env })

    if (env[specKey] === undefined) {
        return devDefault === undefined ? spec.default : devDefault
    }

    return env[specKey]
}

/**
 * If the provided raw value equals the test symbol, throw immediately
 */
function assertTestOnlySymbol({ spec, rawValue }) {
    if (rawValue === testOnlySymbol) {
        throw new EnvMissingError(formatSpecDescription(spec))
    }
}

/**
 * Default values can be anything falsy (including an explicitly set undefined),
 * without triggering validation errors.
 */
function usingFalsyDefault({ spec, env, rawValue }) {
    const isNotProd = env.NODE_ENV !== 'production'
    const hasDevDefault = spec.hasOwnProperty('devDefault')
    const hasDefault = spec.hasOwnProperty('default')

    if (hasDefault && spec.default === rawValue) {
        return true
    }

    if (hasDevDefault && isNotProd && spec.devDefault === rawValue) {
        return true
    }

    return false
}

/**
 * Validates a raw value from the input env. Is aware of falsy defaults.
 */
function validate({ spec, specKey, rawValue, env }) {
    if (rawValue === undefined) {
        if (!usingFalsyDefault({ spec, env, rawValue })) {
            throw new EnvMissingError(formatSpecDescription(spec))
        }

        return undefined
    }

    return validateVar({ name: specKey, spec, rawValue })
}

/**
 * Recursive function to validate the keys in the user-provided spec map.
 * 
 * Keys without a `requiredWhen` are processed first, then the function recurses
 * to validate the keys with a `requiredWhen` property. If `requiredWhen`
 * evaluates to false, any validation error is ignored.
 * 
 * NOTE: `requiredWhen` is provided the output up until the current env var is
 * processed, so it will **not** be the complete parsed output.
 */
function validateSpecs({ specs, env, deferKeys = [], output = {}, options }) {
    const errors = {}
    let hasDeferments = false

    const keysToValidate =
        Array.prototype.isPrototypeOf(deferKeys) && deferKeys.length > 0
            ? deferKeys
            : Object.keys(specs)

    const shouldProcessDeferments = keysToValidate === deferKeys

    keysToValidate.forEach(specKey => {
        const spec = specs[specKey]
        const hasRequiredWhen = typeof spec.requiredWhen === 'function'

        if (!shouldProcessDeferments && hasRequiredWhen) {
            hasDeferments = true
            return deferKeys.push(specKey)
        }

        const rawValue = getRawValue({ spec, env, specKey })

        try {
            assertTestOnlySymbol({ spec, rawValue })
            output[specKey] = validate({ spec, specKey, rawValue, env })
        } catch (error) {
            if (hasRequiredWhen && !spec.requiredWhen(output)) return
            if (options.reporter === null) throw error

            errors[specKey] = error
        }
    })

    if (hasDeferments && deferKeys.length > 0) {
        return validateSpecs({ specs, env, deferKeys, output, options })
    }

    return { output, errors }
}

function cleanEnv(inputEnv, userSpecs = {}, options = {}) {
    const env = getEnv({ inputEnv, options })

    const specs = extend(
        {
            NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'production' })
        },
        userSpecs
    )

    const { output, errors } = validateSpecs({ specs, env, options })

    // If we need to run Object.assign() on output, we must do it before the
    // defineProperties() call, otherwise the properties would be lost
    let finalOutput = options.strict ? output : extend(env, output)

    // Provide is{Prod/Dev/Test} properties for more readable NODE_ENV checks
    // Node that isDev and isProd are just aliases to isDevelopment and isProduction
    Object.defineProperties(finalOutput, {
        isDevelopment: { value: output.NODE_ENV === 'development' },
        isDev: { value: output.NODE_ENV === 'development' },
        isProduction: { value: output.NODE_ENV === 'production' },
        isProd: { value: output.NODE_ENV === 'production' },
        isTest: { value: output.NODE_ENV === 'test' }
    })

    if (options.transformer) {
        finalOutput = options.transformer(finalOutput)
    }

    const reporter = options.reporter || require('./lib/reporter')
    reporter({ errors, env: finalOutput })

    if (options.strict) finalOutput = require('./lib/strictProxy')(finalOutput, env)

    return Object.freeze(finalOutput)
}

/**
* Utility function for providing default values only when NODE_ENV=test
*
* For more context, see https://github.com/af/envalid/issues/32
*/
const testOnly = defaultValueForTests => {
    return process.env.NODE_ENV === 'test' ? defaultValueForTests : testOnlySymbol
}

module.exports = {
    // core API
    cleanEnv,
    makeValidator,
    // error subclasses
    EnvError,
    EnvMissingError,
    // utility function(s)
    testOnly,
    // built-in validators
    bool,
    num,
    str,
    json,
    host,
    port,
    url,
    email
}
