import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, scan, normalizePolicy, MAX_CHARACTERS, MAX_CUSTOM_FIELDS, ScanError } from '../src/index.mjs';

const key = 'sk-proj-' + 'Ab9_'.repeat(14);
const samples = [
  ['OpenAI', key],
  ['Anthropic', 'sk-ant-api03-' + 'aB5-'.repeat(20)],
  ['AWS', 'AKIA' + 'Q9'.repeat(8)],
  ['GitHub', 'ghp_' + 'abCD12'.repeat(7)],
  ['GitHub fine grained', 'github_pat_' + 'a1_B'.repeat(12)],
  ['Google', 'AIza' + 'aB1_'.repeat(8) + 'aB1'],
  ['Stripe', 'sk_live_' + 'ab12'.repeat(8)],
  ['Slack', 'xoxb-' + 'abc12-'.repeat(6)],
  ['JWT', 'eyJ' + 'abc123'.repeat(3) + '.' + 'abcdef1234' + '.' + 'abcdef123456'],
  ['Bearer', 'Authorization: Bearer opaque-value-12345'],
  ['Basic', 'Authorization: Basic dXNlcjpwYXNz'],
  ['database', 'postgres://username:opaque-pass-998@db.example.invalid/data'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC-KEY-MATERIAL\n-----END RSA PRIVATE KEY-----'],
  ['incomplete private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-KEY'],
];
for (const [name, value] of samples) test(`masks ${name}`, () => {
  const output = redact(`Please inspect this: ${value}`);
  assert.ok(output.count > 0);
  assert.ok(!output.text.includes(value));
  assert.equal(redact(output.text).count, 0, 'redaction must be idempotent');
  assert.ok(!JSON.stringify(output.findings).includes(value));
});

test('preserves surrounding code and quoted whitespace', () => {
  assert.equal(redact('const apiKey = "not a real secret";\nconsole.log("hello")').text,
    'const apiKey = "xxxxx";\nconsole.log("hello")');
  assert.equal(redact('{"clientSecret":"fake\\\"credential-tail"}').text, '{"clientSecret":"xxxxx"}');
});
test('rushed and pasted credential formatting masks complete values without losing surrounding text', () => {
  const cases=[
    ['client secret:\nfake-nextline-123','client secret:\nxxxxx'],
    ['API_TOKEN =\r\n\t"fake nextline password"','API_TOKEN =\r\n\t"xxxxx"'],
    ['password=“fake password 123”','password=“xxxxx”'],
    ['password=‘fake password 456’','password=‘xxxxx’'],
    ['api_key="fake-unclosed-123','api_key="xxxxx'],
    ["client_secret='fake unclosed password","client_secret='xxxxx"],
    ['password=“fake unclosed password','password=“xxxxx'],
    ['client\u00a0id:\u00a0fake-nbsp-123','client\u00a0id:\u00a0xxxxx'],
    ['client\u202fsecret\u00a0=\u00a0fake-narrow-space-123','client\u202fsecret\u00a0=\u00a0xxxxx'],
    ['client secret：fake-colon-123','client secret：xxxxx'],
    ['apiToken＝fake-equals-123','apiToken＝xxxxx'],
    ['⚡client-secret=fake-one-123;password="fake two 456"','⚡client-secret=xxxxx;password="xxxxx"'],
  ];
  for(const [input,expected] of cases) {
    const result=redact(input);
    assert.equal(result.text,expected,input);
    assert.equal(redact(result.text).count,0,input);
  }
});
test('authorization schemes count once and complete variable placeholders stay unchanged', () => {
  for(const scheme of ['Bearer','Basic']) {
    const original=`Authorization: ${scheme} synthetic-token-123`;
    const result=redact(original);
    assert.equal(result.count,1,scheme);
    assert.equal(result.text,`Authorization: ${scheme} xxxxx`);
    for(const [open,close] of [['"','"'],["'","'"],['“','”'],['‘','’'],['"','']]) {
      const quoted=redact(`Authorization: ${scheme}\u00a0${open}fake-auth-123${close}`);
      assert.equal(quoted.count,1);
      assert.equal(quoted.text,`Authorization: ${scheme}\u00a0${open}xxxxx${close}`);
      assert.equal(redact(quoted.text).count,0);
    }
    const placeholder=`Authorization: ${scheme} "${'${SERVICE_KEY}'}"`;
    assert.equal(redact(placeholder).text,placeholder);
  }
  for(const value of ['${SERVICE_KEY}','${SERVICE_KEY:-fallback}','$SERVICE_KEY','xxxxx','[REDACTED]']) {
    const original=`api_key=${value}`;
    assert.equal(redact(original).text,original,value);
  }
  assert.equal(redact('api_key=${SERVICE_KEY}-literal-part').text,'api_key=xxxxx');
  assert.equal(redact('client\u00a0id=fake-client-123',{protectClientIds:false}).count,0);
});
test('masks generic, natural language, environment, URL and client ID values', () => {
  for (const label of ['key', 'api_key', 'api_token', 'secret key', 'client_id', 'clientSecret', 'password', 'accessToken', 'MY_SERVICE_API_KEY']) {
    const output = redact(`${label} = synthetic-credential-43757`);
    assert.equal(output.text, `${label} = xxxxx`);
  }
  assert.equal(redact('my api key is made-up-345').text, 'my api key is xxxxx');
  assert.equal(redact('https://example.invalid/?token=fictional-45&view=1').text, 'https://example.invalid/?token=xxxxx&view=1');
});
test('all built-in fields accept case and word-separator variants with the supported assignments', () => {
  for (const field of ['key','api_key','api_token','secret','secret_key','client_secret','access_token','auth_token',
    'refresh_token','password','passwd','pwd','token','private_key','aws_secret_access_key','aws_access_key_id','authorization','client_id']) {
    const words=field.split('_');
    const variants=new Set(['',' ','-','_','  ','\t','_- '].map(separator=>words.join(separator)));
    variants.add(words.map((word,i)=>i?word[0].toUpperCase()+word.slice(1):word).join(''));
    for (const name of variants) for (const label of new Set([name,name.toUpperCase(),name.replace(/[a-z]/g,(letter,i)=>i%2?letter.toUpperCase():letter)])) {
      for (const separator of [': ', ' = ', ' is ', ':    ', '= ', ' =', '\t:\t']) {
        const original=label+separator+'tgdd444';
        const result=redact(original);
        assert.equal(result.count,1,original);
        assert.equal(result.text,label+separator+'xxxxx',original);
      }
      const quoted=`{"${label}": "fictional value with spaces"}`;
      assert.equal(redact(quoted).text,`{"${label}": "xxxxx"}`,quoted);
    }
  }
});
test('built-in spelling variants retain environment prefixes, boundaries and client-ID policy', () => {
  for (const name of ['MY_API_TOKEN','APP-client-secret','APP_clientSecret','AWS-ACCESS-KEY-ID','aws secret access key']) {
    const original=`${name}=synthetic-variant-123`;
    assert.equal(redact(original).text,`${name}=xxxxx`,original);
  }
  for (const name of ['client id','client_id','client-id','clientId','CLIENTID','clienT  Id','client\tid','CLIENT_- ID']) {
    const original=`${name}=synthetic-client-123`;
    assert.equal(redact(original).text,`${name}=xxxxx`,original);
    assert.equal(redact(original,{protectClientIds:false}).count,0,original);
  }
  for (const original of ['clientidentity=example-value','myClientId=example-value','api-tokenizer=example-value',
    'client\nid=example-value','Explain API keys and access tokens.']) assert.equal(redact(original).count,0,original);
  const policy={sensitiveNames:['project_code']};
  assert.equal(redact('PROJECT_CODE=synthetic-custom-123',policy).text,'PROJECT_CODE=xxxxx');
  for (const name of ['projectCode','project-code','project code']) {
    assert.equal(redact(`${name}=synthetic-custom-123`,policy).count,0,name);
  }
});
test('client IDs and custom literal labels follow policy', () => {
  assert.equal(redact('client_id = public-client', { protectClientIds: false }).count, 0);
  assert.equal(redact('internal_code: private-234', { sensitiveNames: ['internal_code'] }).text, 'internal_code: xxxxx');
  const policy = { sensitiveNames: ['dataset1', 'project code'] };
  assert.equal(redact('{"dataset1":"synthetic-data-123"}\nDATASET1: 2468\nproject code is "alpha beta"', policy).text,
    '{"dataset1":"xxxxx"}\nDATASET1: xxxxx\nproject code is "xxxxx"');
  assert.equal(redact('dataset10=public-value-123', policy).count, 0);
  assert.equal(redact('dataset1=xxxxx', policy).count, 0);
});
test('repeated values and overlapping findings are masked without corrupting punctuation', () => {
  const value = 'fictional-key-123';
  assert.equal(redact(`api_key="${value}" repeat ${value}`).text, 'api_key="xxxxx" repeat xxxxx');
  assert.equal(redact(`api_key="${key}"`).count, 1);
});
test('ordinary text and existing redactions are preserved', () => {
  for (const value of ['Explain how API keys work.', 'const value = 123;', 'password = xxxxx', 'password = [REDACTED]', 'api_key="[REDACTED]"', 'api_key="${SERVICE_KEY}"', 'Use <API_KEY> here.']) {
    assert.equal(redact(value).text, value);
  }
});
test('invalid inputs and invalid policies fail closed with generic errors', () => {
  for (const value of [null, {}, 'x'.repeat(MAX_CHARACTERS + 1)]) assert.throws(() => scan(value), ScanError);
  for (const policy of [{mode:'allow'}, {protectClientIds:'false'}, {sensitiveNames:['(a+)+$']}, {sensitiveNames:Array(MAX_CUSTOM_FIELDS + 1).fill('xx')}, null]) {
    assert.throws(() => normalizePolicy(policy), ScanError);
  }
  assert.equal(redact('a'.repeat(MAX_CHARACTERS)).count, 0);
});
test('an explicit prompt-sized limit scans the complete draft beyond the default cap', () => {
  const original='password=synthetic-start-123\n'+'plain text '.repeat(10000)+
    'api_key=synthetic-middle-456\n'+'plain text '.repeat(100000)+'client_secret=synthetic-end-789';
  const result=redact(original,undefined,original.length);
  assert.equal(result.count,3);
  assert.equal(result.text,original.replace('synthetic-start-123','xxxxx').replace('synthetic-middle-456','xxxxx').replace('synthetic-end-789','xxxxx'));
  assert.equal(scan(original,undefined,original.length).length,3);
  assert.equal(scan(result.text,undefined,result.text.length).length,0);
  assert.throws(()=>redact(original),ScanError);
  for (const limit of [original.length-1,-1,Infinity,NaN,'2000000']) {
    assert.throws(()=>scan(original,undefined,limit),ScanError);
  }
});
test('prompt-sized scanning preserves credentials across the former character boundary', () => {
  const prefix='text '.repeat(MAX_CHARACTERS/5-2);
  const original=prefix+'api_key="synthetic-cross-boundary-123"\n'+
    '🛡️ '.repeat(40000)+'repeat synthetic-cross-boundary-123';
  const result=redact(original,undefined,original.length);
  assert.equal(result.count,2);
  assert.equal(result.text,original.replaceAll('synthetic-cross-boundary-123','xxxxx'));
  assert.equal(redact('text '.repeat(220000),undefined,1100000).count,0);
  const excessive=Array.from({length:500},(_,i)=>`api_key="fictional-value-${i}"`).join('\n').repeat(4);
  assert.throws(()=>redact(excessive,undefined,excessive.length),ScanError);
});
test('all 50 custom fields are scanned and a 51st field is rejected', () => {
  assert.equal(MAX_CUSTOM_FIELDS, 50);
  const sensitiveNames = Array.from({length:MAX_CUSTOM_FIELDS}, (_, i) => 'dataset' + i);
  const policy = normalizePolicy({ sensitiveNames });
  assert.equal(policy.sensitiveNames.length, MAX_CUSTOM_FIELDS);
  const text = sensitiveNames.map((name, i) => `${name}=${i + 1}`).join('\n');
  const result = redact(text, policy);
  assert.equal(result.count, MAX_CUSTOM_FIELDS);
  assert.equal(result.text, sensitiveNames.map(name => `${name}=xxxxx`).join('\n'));
  assert.throws(() => normalizePolicy({sensitiveNames:[...sensitiveNames, 'overflow_field']}), ScanError);
});
test('many repeated detections are deduplicated and excessive distinct scan work rejects', () => {
  assert.equal(redact(('api_key=synthetic-repeat-123\n').repeat(1000)).count,1000);
  const input=Array.from({length:500},(_,i)=>`api_key="fictional-value-${i}"`).join('\n');
  assert.throws(()=>redact(input.repeat(4)),ScanError);
});
