'use strict'

module.exports = {
  find,
  insert,
  ls,
  lsStream,
  delete: del,
  _hashKey: hashKey,
  _bucketPath: bucketPath
}

const contentPath = require('./content/path')
const crypto = require('crypto')
const fixOwner = require('./util/fix-owner')
const fs = require('graceful-fs')
const path = require('path')
const Promise = require('bluebird')
const ms = require('mississippi')
const hashToSegments = require('./util/hash-to-segments')

const indexV = require('../package.json')['cache-version'].index

const appendFileAsync = Promise.promisify(fs.appendFile)
const readFileAsync = Promise.promisify(fs.readFile)
const readdirAsync = Promise.promisify(fs.readdir)
const concat = ms.concat
const from = ms.from

module.exports.NotFoundError = class NotFoundError extends Error {
  constructor (cache, key) {
    super('content not found')
    this.code = 'ENOENT'
    this.cache = cache
    this.key = key
  }
}

function insert (cache, key, digest, opts) {
  opts = opts || {}
  const bucket = bucketPath(cache, key)
  return fixOwner.mkdirfix(
    path.dirname(bucket), opts.uid, opts.gid
  ).then(() => {
    const entry = {
      key: key,
      digest: digest,
      hashAlgorithm: opts.hashAlgorithm,
      time: +(new Date()),
      metadata: opts.metadata
    }
    const stringified = JSON.stringify(entry)
    // NOTE - Cleverness ahoy!
    //
    // This works because it's tremendously unlikely for an entry to corrupt
    // another while still preserving the string length of the JSON in
    // question. So, we just slap the length in there and verify it on read.
    //
    // Thanks to @isaacs for the whiteboarding session that ended up with this.
    return appendFileAsync(
      bucket, `\n${stringified.length}\t${stringified}`
    ).then(() => entry)
  }).then(entry => (
    fixOwner.chownr(bucket, opts.uid, opts.gid).then(() => (
      formatEntry(cache, entry)
    ))
  ))
}

function find (cache, key) {
  const bucket = bucketPath(cache, key)
  return bucketEntries(cache, bucket).then(entries => {
    return entries.reduce((latest, next) => {
      if (next && next.key === key) {
        return formatEntry(cache, next)
      } else {
        return latest
      }
    }, null)
  }).catch(err => {
    if (err.code === 'ENOENT') {
      return null
    } else {
      throw err
    }
  })
}

function del (cache, key) {
  return insert(cache, key, null)
}

function lsStream (cache) {
  const indexDir = bucketDir(cache)
  const stream = from.obj()

  // "/cachename/*"
  readdirAsync(indexDir).map(bucket => {
    const bucketPath = path.join(indexDir, bucket)

    // "/cachename/<bucket 0xFF>/*"
    return readdirAsync(bucketPath).map(subbucket => {
      const subbucketPath = path.join(bucketPath, subbucket)

      // "/cachename/<bucket 0xFF>/<bucket 0xFF>/*"
      return readdirAsync(subbucketPath).map(entry => {
        const getKeyToEntry = bucketEntries(
          cache,
          path.join(subbucketPath, entry)
        ).reduce((acc, entry) => {
          acc.set(entry.key, entry)
          return acc
        }, new Map())

        return getKeyToEntry.then(reduced => {
          return Array.from(reduced.values()).map(
            entry => stream.push(formatEntry(cache, entry))
          )
        }).catch({code: 'ENOENT'}, nop)
      }).catch({code: 'ENOENT'}, nop)
    }).catch({code: 'ENOENT'}, nop)
  }).catch({code: 'ENOENT'}, nop).then(() => {
    stream.push(null)
  }, err => {
    stream.emit('error', err)
  })
  return stream
}

function ls (cache) {
  return Promise.fromNode(cb => {
    lsStream(cache).on('error', cb).pipe(concat(entries => {
      cb(null, entries.reduce((acc, xs) => {
        acc[xs.key] = xs
        return acc
      }, {}))
    }))
  })
}

function bucketEntries (cache, bucket, filter) {
  return readFileAsync(
    bucket, 'utf8'
  ).then(data => {
    let entries = []
    data.split('\n').forEach(entry => {
      const pieces = entry.split('\t')
      if (!pieces[1] || pieces[1].length !== parseInt(pieces[0], 10)) {
        // Length is no good! Corruption ahoy!
        return
      }
      let obj
      try {
        obj = JSON.parse(pieces[1])
      } catch (e) {
        // Entry is corrupted!
        return
      }
      if (obj) {
        entries.push(obj)
      }
    })
    return entries
  })
}

function bucketDir (cache) {
  return path.join(cache, `index-v${indexV}`)
}

function bucketPath (cache, key) {
  const hashed = hashKey(key)
  return path.join.apply(path, [bucketDir(cache)].concat(
    hashToSegments(hashed)
  ))
}

function hashKey (key) {
  return crypto
  .createHash('sha256')
  .update(key)
  .digest('hex')
}

function formatEntry (cache, entry) {
  return {
    key: entry.key,
    digest: entry.digest,
    hashAlgorithm: entry.hashAlgorithm,
    path: contentPath(cache, entry.digest, entry.hashAlgorithm),
    time: entry.time,
    metadata: entry.metadata
  }
}

function nop () {
}
