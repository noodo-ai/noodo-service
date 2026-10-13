import Anthropic from '@anthropic-ai/sdk'
const key = process.env.ANTHROPIC_API_KEY?.trim()
if (!key) {
  console.error('Missing ANTHROPIC_API_KEY')
  process.exitCode = 1
} else {
  try {
    const sdk = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 20000 })
    for await (const model of sdk.models.list())
      console.log(`${model.id}\t${model.display_name}`)
  } catch {
    console.error(
      'Model listing failed; verify your API key, API billing, network and account permissions',
    )
    process.exitCode = 1
  }
}
