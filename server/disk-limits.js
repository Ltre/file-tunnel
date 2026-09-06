'use strict';
// Decimal MB also stays below the cloud getFile 20 MB download ceiling.
const MAX_TELEGRAM_PART_SIZE = 20_000_000;
// Leave multipart overhead below cloud/proxy request limits, including albums.
const MAX_TELEGRAM_BATCH_SIZE = 40_000_000;
module.exports = { MAX_TELEGRAM_PART_SIZE, MAX_TELEGRAM_BATCH_SIZE };
