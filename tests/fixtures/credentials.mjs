// Synthetic, independently specified input/output pairs shared by scanner and browser tests.
const mask = 'xxxxxxxxxx';
const single = (name, value) => ({ name, input: `Inspect ${value}`, masked: `Inspect ${mask}`, count: 1 });
export const credentialCases = [
  single('OpenAI project key', 'sk-proj-' + 'Synthetic9_'.repeat(5)),
  single('OpenAI service account key', 'sk-svcacct-' + 'Synthetic8_'.repeat(5)),
  single('OpenAI legacy key', 'sk-' + 'Synthetic7'.repeat(5)),
  single('Anthropic API key', 'sk-ant-api03-' + 'Synthetic6-'.repeat(5)),
  single('Anthropic admin key', 'sk-ant-admin01-' + 'Synthetic5-'.repeat(5)),
  single('Google API key', 'AIza' + 'Ab9_'.repeat(8) + 'Ab9'),
  ...['p', 'o', 'u', 's', 'r'].map(kind => single(`GitHub ${kind} token`, `gh${kind}_` + 'Synthetic123'.repeat(4))),
  single('GitHub fine-grained token', 'github_pat_' + 'Synthetic1_'.repeat(5)),
  ...['b', 'a', 'p', 'r', 's'].map(kind => single(`Slack ${kind} token`, `xox${kind}-` + 'Synthetic1-'.repeat(3))),
  ...['AKIA', 'ASIA'].map(prefix => single(`AWS ${prefix} ID`, prefix + 'Q9'.repeat(8))),
  ...['sk', 'rk'].flatMap(kind => ['live', 'test'].map(mode => single(`Stripe ${kind} ${mode}`, `${kind}_${mode}_` + 'Synthetic123'.repeat(3)))),
  single('SendGrid API key', 'SG.' + 'Synthetic1_'.repeat(3) + '.' + 'Synthetic2_'.repeat(4)),
  single('JWT', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljX3NpZ25hdHVyZQ'),
  ...['key', 'api_key', 'api_token', 'secret', 'secret_key', 'client_secret', 'access_token', 'auth_token',
    'refresh_token', 'password', 'passwd', 'pwd', 'token', 'private_key', 'aws_secret_access_key',
    'aws_access_key_id', 'authorization', 'client_id', 'dataset_key'].map((name, i) => {
    const field = name === 'dataset_key' ? name : name.split('_').map((word, j) => j ? word[0].toUpperCase() + word.slice(1) : word).join('');
    const separator = [': ', ' = ', ' is ', '：', '＝', ':    ', '='][i % 7];
    return { name: `labeled ${name}`, input: `${field}${separator}synthetic-field-${i}-123`, masked: `${field}${separator}${mask}`, count: 1 };
  }),
  ...['Bearer', 'Basic'].flatMap(scheme => ['', '"', '`', '“'].map(quote => {
    const end = quote === '“' ? '”' : quote;
    return { name: `${scheme} ${quote || 'bare'}`, input: `Authorization: ${scheme} ${quote}synthetic-auth-123${end}`,
      masked: `Authorization: ${scheme} ${quote}${mask}${end}`, count: 1 };
  })),
  ...['postgres', 'mysql', 'mongodb+srv', 'redis', 'https'].map(protocol => ({ name: `${protocol} connection password`,
    input: `${protocol}://user:synthetic-pass-123@db.example.invalid/test`, masked: `${protocol}://user:${mask}@db.example.invalid/test`, count: 1 })),
  ...['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PRIVATE KEY'].map(kind => ({
    name: kind, input: `Before\n-----BEGIN ${kind}-----\nSYNTHETIC-MATERIAL\n-----END ${kind}-----\nAfter`, masked: `Before\n${mask}\nAfter`, count: 1,
  })),
  { name: 'repeated value and non-Latin context', input: '説明 🔐 api_key="synthetic-repeat-123"\nपुनः synthetic-repeat-123',
    masked: `説明 🔐 api_key="${mask}"\nपुनः ${mask}`, count: 2 },
  { name: 'JSON escaped quote', input: '{"clientSecret":"synthetic\\"quoted-value-123"}', masked: `{"clientSecret":"${mask}"}`, count: 1 },
  { name: 'quoted password with whitespace', input: 'password = “synthetic secret phrase”', masked: `password = “${mask}”`, count: 1 },
  { name: 'next-line value', input: 'client_secret:\nsynthetic-next-line-123', masked: `client_secret:\n${mask}`, count: 1 },
  { name: 'fenced value', input: 'client_secret:\n```text\nsynthetic-fenced-123\n```', masked: `client_secret:\n\x60\x60\x60${mask}\x60\x60\x60`, count: 1 },
  { name: 'unclosed quote', input: 'password="synthetic unfinished phrase', masked: `password="${mask}`, count: 1 },
  { name: 'empty assignment followed by another field', input: 'password:\nclient_secret: synthetic-following-123', masked: `password:\nclient_secret: ${mask}`, count: 1 },
  { name: 'URL query parameter', input: 'https://example.invalid/?token=synthetic-query-123&view=1', masked: `https://example.invalid/?token=${mask}&view=1`, count: 1 },
  { name: 'bare Bearer token', input: 'Use Bearer synthetic-bare-123 for this request.', masked: `Use Bearer ${mask} for this request.`, count: 1 },
  { name: 'bare Basic credential', input: 'Basic dXNlcjpwYXNz', masked: `Basic ${mask}`, count: 1 },
  { name: 'distant client credentials', input: 'client id and client secret are at the bottom.\nConnection details.\nQ7mV8z2R9tA4nP6xL3cD\nB9wK4s8H2yF7vN5rT6aZ', masked: `client id and client secret are at the bottom.\nConnection details.\n${mask}\n${mask}`, count: 2 },
  { name: 'distant values with CRLF', input: 'clienT Id, clienT-secret are shown later.\r\nSome explanation.\r\n  Q7mV8z2R9tA4nP6xL3cD\r\n  B9wK4s8H2yF7vN5rT6aZ', masked: `clienT Id, clienT-secret are shown later.\r\nSome explanation.\r\n  ${mask}\r\n  ${mask}`, count: 2 },
  { name: 'keyword-triggered bullet values', input: 'apiKey & access-token are included below.\n- Q7mV8z2R9tA4nP6xL3cD\n- B9wK4s8H2yF7vN5rT6aZ', masked: `apiKey & access-token are included below.\n- ${mask}\n- ${mask}`, count: 2 },
  { name: 'distant values with blank paragraphs', input: 'my client id and client secret are shown below.\n\nQ7mV8z2R9tA4nP6xL3cD\n\nB9wK4s8H2yF7vN5rT6aZ\nExplain this config.', masked: `my client id and client secret are shown below.\n\n${mask}\n\n${mask}\nExplain this config.`, count: 2 },
  { name: 'keyword-triggered numbered values', input: 'api_key, password, and client secret are included below.\n1. Q7mV8z2R9tA4nP6xL3cD\n2. "B9wK4s8H2yF7vN5rT6aZ"\n3. N6cY9tR2mQ5vB8xL4sP7', masked: `api_key, password, and client secret are included below.\n1. ${mask}\n2. "${mask}"\n3. ${mask}`, count: 3 },
  { name: 'quoted keyword mentions', input: '`client id` and `client secret` are at the bottom.\n"Q7mV8z2R9tA4nP6xL3cD"\n“B9wK4s8H2yF7vN5rT6aZ”', masked: `\x60client id\x60 and \x60client secret\x60 are at the bottom.\n"${mask}"\n“${mask}”`, count: 2 },
  { name: 'distant secret key values', input: 'secret key and password are included below.\nQ7mV8z2R9tA4nP6xL3cD\nB9wK4s8H2yF7vN5rT6aZ', masked: `secret key and password are included below.\n${mask}\n${mask}`, count: 2 },
  { name: 'distant custom values', input: 'dataset_key and password are included below.\nQ7mV8z2R9tA4nP6xL3cD\nB9wK4s8H2yF7vN5rT6aZ', masked: `dataset_key and password are included below.\n${mask}\n${mask}`, count: 2 },
];

export const plainCases = [
  'Explain how API keys work.', 'Generate a client secret using a password manager.',
  'Use environment variables for credentials.', 'const count = 123;',
  'clientidentity=public-example', 'api-tokenizer=public-example',
  'api_key=xxxxxxxxxx', 'password=[REDACTED]', 'client_secret=${SERVICE_KEY}',
  'api_key="${SERVICE_KEY}"', 'Use <API_KEY> in the example.',
  'A plain prompt in 日本語 and हिन्दी 🔐.',
  'Explain the basic authentication flow.', 'Explain bearer authentication.',
  'The key is to retry with exponential backoff.', 'The secret is to keep trying.',
  'Basic authentication is an HTTP scheme.', 'Bearer authentication uses an access token.',
  'Our key is to test carefully.', 'The key is that retries need a delay.',
  'Client ID and client secret are app credentials.',
  'client id and client secret are\nrequired for authentication.',
];
