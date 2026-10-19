'use strict';
require('./pending-save-261012-fixture.cjs').createFixture({ serverTransfers: true }).then(fixture => {
    console.log(JSON.stringify({ base: fixture.base, isolatedDataDir: fixture.dataDir }));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => fixture.close().then(() => process.exit()));
});
