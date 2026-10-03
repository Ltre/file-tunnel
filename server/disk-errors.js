'use strict';
const { networkDetails } = require('./disk-upload-log');

function diskErrorCode(error) {
    for (const value of [error?.code, error?.message]) {
        if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) return value;
    }
    return 'DISK_REQUEST_FAILED';
}

// Public diagnostics must not contain Bot URLs, cookies, request bodies or local paths.
function diskErrorDetails(error) {
    const details = {};
    const source = error?.details || error?.errorDetails || {};
    for (const name of ['requestId', 'method', 'stage', 'reason', 'elapsedMs', 'causeCode', 'syscall', 'requestNotAccepted', 'requestIncomplete', 'requestOutcomeUnknown', 'sentBodyBytes', 'sentFileBytes', 'lastSentAt', 'bodySentAt']) {
        if (typeof source[name] === 'string') details[name] = networkDetails({ message: source[name] }).message;
        else if (['number', 'boolean'].includes(typeof source[name])) details[name] = source[name];
    }
    const description = error?.telegramDescription || source.telegramDescription;
    if (description) details.telegramDescription = networkDetails({ message: description }).message;
    for (const name of ['expectedMessages', 'receivedMessages']) if (Number.isSafeInteger(source[name])) details[name] = source[name];
    return details;
}

module.exports = { diskErrorCode, diskErrorDetails };
