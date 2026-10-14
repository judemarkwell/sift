import { describe, expect, it } from 'vitest'

import { maskSecret, secretsFrom, splitSecrets, withoutSecrets, type Secret } from './secrets'

const KEY = 'sk-ant-api03-REALKEYVALUE1234567890abc'
const s: Secret = { value: KEY, kind: 'API_KEY', placeholder: '[API_KEY_1]' }

describe('withoutSecrets', () => {
  it('uses os.environ in Python and adds the import', () => {
    const out = withoutSecrets(`client = Anthropic(api_key="${KEY}")`, 'python', [s])
    expect(out).toBe('import os\nclient = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])')
  })
  it("doesn't add a second import", () => {
    const out = withoutSecrets(`import os\nkey = '${KEY}'`, 'py', [s])
    expect(out).toBe('import os\nkey = os.environ["ANTHROPIC_API_KEY"]')
  })
  it('uses process.env in JS, including template literals', () => {
    expect(withoutSecrets(`const k = "${KEY}"`, 'ts', [s])).toBe('const k = process.env.ANTHROPIC_API_KEY')
    expect(withoutSecrets('const h = `Bearer ' + KEY + '`', 'js', [s])).toBe(
      'const h = `Bearer ${process.env.ANTHROPIC_API_KEY}`',
    )
  })
  it('uses $VAR in shell and switches single quotes so it expands', () => {
    const out = withoutSecrets(`curl -H 'x-api-key: ${KEY}' https://api.anthropic.com`, 'bash', [s])
    expect(out).toBe('curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com')
  })
  it('blanks .env values in any language', () => {
    expect(withoutSecrets(`ANTHROPIC_API_KEY=${KEY}\nOTHER=1`, 'env', [s])).toBe('ANTHROPIC_API_KEY=\nOTHER=1')
    expect(withoutSecrets(`export KEY="${KEY}"`, 'bash', [s])).toBe('export KEY=')
  })
  it('falls back to YOUR_NAME elsewhere and never leaves the key', () => {
    const out = withoutSecrets(`key: ${KEY}`, 'yaml', [s])
    expect(out).toBe('key: YOUR_ANTHROPIC_API_KEY')
    for (const lang of ['python', 'js', 'bash', 'go', '']) {
      expect(withoutSecrets(`x = "${KEY}"; y = 'pre${KEY}post'; z=${KEY}`, lang, [s])).not.toContain(KEY)
    }
  })
})

describe('masking', () => {
  it('shows only the public prefix and last 3 characters', () => {
    expect(maskSecret(s)).toBe('sk-ant-…abc')
    expect(maskSecret({ value: 'hunter22', kind: 'PASSWORD', placeholder: '' })).toBe('••••••••')
  })
  it('finds secrets from marks and splits text around them', () => {
    const text = `key ${KEY} and mail a@b.co`
    const found = secretsFrom(text, [
      { kind: 'API_KEY', placeholder: '[API_KEY_1]', start: 4, end: 4 + KEY.length },
      { kind: 'EMAIL', placeholder: '[EMAIL_1]', start: text.length - 6, end: text.length },
    ])
    expect(found.map((f) => f.kind)).toEqual(['API_KEY'])
    expect(splitSecrets(text, found)).toEqual(['key ', found[0], ' and mail a@b.co'])
  })
})
