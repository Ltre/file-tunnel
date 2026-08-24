const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    resolveYoutubeAlbumArtist,
    resolveYoutubeAlbumArtistFromEntries
} = require('../server/youtube-premium');

test('missing album_artist fields do not guess from the single track artist', () => {
    const fieldMissingFixture = {
        id: 'XnWxihjgR-E',
        album: 'Summer in Blue',
        artist: 'Yuri Kunizane'
    };
    assert.equal(resolveYoutubeAlbumArtist(fieldMissingFixture), '');
});

test('a matched YouTube Music album derives one album artist from Topic channels', () => {
    const albumEntries = [
        { id: 'uSMg9u5Mezg', channel: 'Yuri Kunizane - Topic' },
        { id: 'XnWxihjgR-E', channel: 'Yuri Kunizane - Topic' },
        { id: 'SDLoNI2xElM', uploader: 'Yuri Kunizane - Topic' }
    ];
    assert.equal(resolveYoutubeAlbumArtistFromEntries(albumEntries), 'Yuri Kunizane');
});

test('legacy cached analyses repair album artist and discard fabricated Track/Disc defaults', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const helper = server.slice(
        server.indexOf('async function enrichYoutubePremiumAnalysisOrdinals'),
        server.indexOf('async function analyzeYoutubePremiumUrl')
    );
    assert.match(helper, /musicAlbumLookupCompleted === true/);
    assert.match(helper, /const trustedCurrentTrack = currentTrack === '1' \? '' : currentTrack/);
    assert.match(helper, /const trustedCurrentDisc = currentDisc === '1' \? '' : currentDisc/);
    assert.match(helper, /album: analysis\.songMetadata\.album \|\| analysis\.referenceInfo\?\.album/);
    assert.match(helper, /album_artist: currentAlbumArtist \|\| analysis\.referenceInfo\?\.albumArtist/);
    assert.match(helper, /album_artist: nextAlbumArtist/);
    assert.match(helper, /albumArtist: analysis\.referenceInfo\.albumArtist \|\| nextAlbumArtist/);
    assert.match(helper, /musicAlbumLookupCompleted: true/);
});

test('fresh analysis performs only one bounded album lookup and never fabricates ordinals', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const analyze = server.slice(
        server.indexOf('async function analyzeYoutubePremiumUrl'),
        server.indexOf('function moveYoutubePremiumOutput')
    );
    assert.match(server, /YOUTUBE_MUSIC_ALBUM_LOOKUP_TIMEOUT_MS/);
    assert.match(server, /slice\(0, 3\)/);
    assert.doesNotMatch(analyze, /await enrichYoutubePremiumAnalysisOrdinals/);
    assert.doesNotMatch(server, /youtube-music-track-number-defaulted/);
    assert.doesNotMatch(server, /disc_number: meta\.disc_number \|\| ordinal\.discNumber \|\| '1'/);
});

test('album artist resolution preserves compilation and ambiguous-album protection', () => {
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Compilation Album',
        album_artist: null,
        artist: 'Track Artist'
    }), '');
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Compilation Album',
        album_artists: [],
        artists: ['Track Artist']
    }), '');
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Compilation Album',
        album_artist: 'Various Artists',
        artist: 'Track Artist'
    }), '群星');
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Flagged Compilation',
        compilation: true,
        artist: 'Track Artist'
    }), '群星');
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Ambiguous Album',
        artists: ['Artist A', 'Artist B']
    }), '');
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Artist Album',
        album_artist: 'Explicit Album Artist',
        artist: 'Track Artist'
    }), 'Explicit Album Artist');
    assert.equal(resolveYoutubeAlbumArtistFromEntries([
        { channel: 'Artist A - Topic' },
        { channel: 'Artist B - Topic' }
    ]), '群星');
    assert.equal(resolveYoutubeAlbumArtistFromEntries([
        { channel: 'Various Artists - Topic' }
    ]), '群星');
    assert.equal(resolveYoutubeAlbumArtistFromEntries([
        { channel: 'Ordinary upload channel' }
    ]), '');
});
