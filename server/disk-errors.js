'use strict';
const { networkDetails } = require('./disk-upload-log');
const messages = require('../client/disk-error-messages');
function diskOperationError(code, reason, details = {}) {
    const error = new Error(code); error.code = code;
    error.details = { ...details, reason }; return error;
}
function diskUserMessage(error) { return messages.describe(diskErrorCode(error), error?.details?.reason || error?.errorDetails?.reason, error?.details || error?.errorDetails); }

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
    if (source.reason === 'DESTINATION_INSIDE_SOURCE') for (const name of ['sourcePath','targetPath'])
        if (typeof source[name] === 'string') details[name] = source[name].slice(0,300);
    if(['NAME_CONFLICT','NAME_PENDING_UPLOAD','PATH_BLOCKED_BY_FILE','STATIC_FILE_OPEN','STATIC_DIRECTORY_OPEN','MOUNT_IN_SOURCE','TRASH_PARENT_BLOCKED'].includes(source.reason)&&typeof source.targetPath==='string')details.targetPath=source.targetPath.slice(0,300);
    if (description) details.telegramDescription = networkDetails({ message: description }).message;
    for (const name of ['expectedMessages', 'receivedMessages']) if (Number.isSafeInteger(source[name])) details[name] = source[name];
    return details;
}

module.exports = { diskErrorCode, diskErrorDetails, diskOperationError, diskUserMessage };
