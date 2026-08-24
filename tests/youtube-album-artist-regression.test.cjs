const test = require('node:test');
const assert = require('node:assert/strict');
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
