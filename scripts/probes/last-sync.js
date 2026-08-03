// Sonda de verificacion E2E (solo lectura): ultimo job, mapping y audit trail.
require('dotenv').config()
const { MongoClient } = require('mongodb')

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  const db = client.db()

  const job = (await db.collection('jobs').find({}).sort({ createdAt: -1 }).limit(1).toArray())[0]
  if (!job) {
    console.log('no hay jobs')
    await client.close()
    return
  }

  console.log('=== JOB ===')
  console.log(JSON.stringify({
    _id: job._id, sourceId: job.sourceId, status: job.status,
    attempts: job.attempts, lastError: job.lastError,
    correlationId: job.correlationId, createdAt: job.createdAt, updatedAt: job.updatedAt
  }, null, 2))

  const mapping = await db.collection('mappings').findOne({ sourceId: job.sourceId })
  console.log('\n=== MAPPING ===')
  console.log(JSON.stringify(mapping, null, 2))

  const audit = await db.collection('audits')
    .find({ $or: [{ sourceId: job.sourceId }, { correlationId: job.correlationId }] })
    .sort({ createdAt: 1 }).toArray()
  console.log('\n=== AUDIT ===')
  for (const a of audit) {
    console.log(`${a.createdAt && a.createdAt.toISOString()}  ${a.event}  ${JSON.stringify(a.detail || {})}`)
  }

  await client.close()
}

main().catch((err) => { console.error(err); process.exit(1) })
