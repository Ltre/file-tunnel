const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveYoutubeAlbumArtist } = require('../server/youtube-premium');

test('YouTube Music normal single-artist albums recover album artist when yt-dlp omits album_artist fields', () => {
    const fieldMissingFixture = {
        id: 'XnWxihjgR-E',
        album: 'fixture-album',
        artist: 'fixture-album-artist'
    };
    assert.equal(resolveYoutubeAlbumArtist(fieldMissingFixture), 'fixture-album-artist');
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Artist Album',
        artists: ['Album Artist', 'Album Artist']
    }), 'Album Artist');
});

test('album artist fallback does not undo compilation and ambiguous multi-artist protection', () => {
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Compilation Album',
        album_artist: null,
        artist: 'Track Artist'
    }), '群星');
    assert.equal(resolveYoutubeAlbumArtist({
        album: 'Compilation Album',
        album_artists: [],
        artists: ['Track Artist']
    }), '群星');
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
});
