import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSecretBox,
  deriveKey,
  hmacSha256Base64,
  hmacSha256Hex,
  randomId,
  randomToken,
  sha256Hex,
  timingSafeEqualStr,
} from '../src/lib/crypto.ts';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);

/** Troca um bit do segmento `index` (já decodificado) e remonta o blob. */
function flipBit(blob: string, index: number, byte = 0): string {
  const parts = blob.split('.');
  const raw = Buffer.from(parts[index] ?? '', 'base64url');
  raw[byte] = (raw[byte] ?? 0) ^ 0x01;
  parts[index] = raw.toString('base64url');
  return parts.join('.');
}

describe('createSecretBox', () => {
  it('cifra e decifra', () => {
    const box = createSecretBox(KEY);
    for (const plain of ['shpss_0123456789abcdef', '', 'ação çãõ 日本語 🔐', 'x'.repeat(10_000), 'com.pontos.e\nquebras']) {
      assert.equal(box.decrypt(box.encrypt(plain)), plain);
    }
  });

  it('usa o formato v1.<iv>.<tag>.<dados> em base64url', () => {
    const blob = createSecretBox(KEY).encrypt('segredo');
    const parts = blob.split('.');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'v1');
    for (const part of parts.slice(1)) assert.match(part, /^[A-Za-z0-9_-]*$/);
    assert.equal(Buffer.from(parts[1] ?? '', 'base64url').length, 12);
    assert.equal(Buffer.from(parts[2] ?? '', 'base64url').length, 16);
    assert.equal(Buffer.from(parts[3] ?? '', 'base64url').length, Buffer.byteLength('segredo'));
  });

  it('não deixa o texto original visível no resultado', () => {
    const plain = 'shpss_segredo_muito_reconhecivel';
    const blob = createSecretBox(KEY).encrypt(plain);
    assert.ok(!blob.includes(plain));
    assert.ok(!blob.includes(Buffer.from(plain).toString('base64url')));
  });

  it('gera um resultado diferente a cada vez (IV aleatório)', () => {
    const box = createSecretBox(KEY);
    const blobs = new Set(Array.from({ length: 200 }, () => box.encrypt('mesmo texto')));
    assert.equal(blobs.size, 200);
    const ivs = new Set([...blobs].map((blob) => blob.split('.')[1]));
    assert.equal(ivs.size, 200);
  });

  it('caixas com a mesma chave são compatíveis', () => {
    const blob = createSecretBox(KEY).encrypt('segredo');
    assert.equal(createSecretBox(Buffer.from(KEY)).decrypt(blob), 'segredo');
  });

  it('não decifra com outra chave', () => {
    const blob = createSecretBox(KEY).encrypt('segredo');
    assert.throws(() => createSecretBox(OTHER_KEY).decrypt(blob));
  });

  it('detecta adulteração do texto cifrado', () => {
    const box = createSecretBox(KEY);
    const blob = box.encrypt('segredo de teste com algum tamanho');
    const dataLength = Buffer.from(blob.split('.')[3] ?? '', 'base64url').length;
    for (let byte = 0; byte < dataLength; byte += 1) {
      assert.throws(() => box.decrypt(flipBit(blob, 3, byte)), `byte ${byte}`);
    }
  });

  it('detecta adulteração da tag de autenticação', () => {
    const box = createSecretBox(KEY);
    const blob = box.encrypt('segredo');
    for (let byte = 0; byte < 16; byte += 1) {
      assert.throws(() => box.decrypt(flipBit(blob, 2, byte)), `byte ${byte}`);
    }
  });

  it('detecta adulteração do IV', () => {
    const box = createSecretBox(KEY);
    const blob = box.encrypt('segredo');
    for (let byte = 0; byte < 12; byte += 1) {
      assert.throws(() => box.decrypt(flipBit(blob, 1, byte)), `byte ${byte}`);
    }
  });

  it('detecta texto cifrado truncado ou estendido', () => {
    const box = createSecretBox(KEY);
    const parts = box.encrypt('segredo de teste').split('.');
    const data = Buffer.from(parts[3] ?? '', 'base64url');
    const withData = (next: Buffer): string => [parts[0], parts[1], parts[2], next.toString('base64url')].join('.');
    assert.throws(() => box.decrypt(withData(data.subarray(0, data.length - 1))));
    assert.throws(() => box.decrypt(withData(Buffer.concat([data, Buffer.from([0])]))));
    assert.throws(() => box.decrypt(withData(Buffer.alloc(0))));
  });

  it('não aceita peças trocadas entre dois segredos', () => {
    const box = createSecretBox(KEY);
    const a = box.encrypt('segredo A').split('.');
    const b = box.encrypt('segredo B').split('.');
    assert.throws(() => box.decrypt([a[0], a[1], a[2], b[3]].join('.')));
    assert.throws(() => box.decrypt([a[0], b[1], a[2], a[3]].join('.')));
    assert.throws(() => box.decrypt([a[0], a[1], b[2], a[3]].join('.')));
  });

  it('rejeita formatos inválidos', () => {
    const box = createSecretBox(KEY);
    const [version, iv, tag, data] = box.encrypt('segredo').split('.') as [string, string, string, string];
    const invalid = [
      '',
      'texto puro',
      'v1',
      'v1...',
      `${version}.${iv}.${tag}`,
      `${version}.${iv}.${tag}.${data}.extra`,
      `v2.${iv}.${tag}.${data}`,
      `V1.${iv}.${tag}.${data}`,
      `.${iv}.${tag}.${data}`,
      `${version}.${iv.slice(2)}.${tag}.${data}`,
      `${version}.${iv}AAAA.${tag}.${data}`,
      `${version}.${iv}.${tag.slice(4)}.${data}`,
      `${version}.${iv}.${tag}AAAA.${data}`,
      `${version}..${tag}.${data}`,
      `${version}.${iv}..${data}`,
    ];
    for (const blob of invalid) {
      assert.throws(() => box.decrypt(blob), Error, JSON.stringify(blob));
    }
  });

  it('exige chave de 32 bytes', () => {
    for (const length of [0, 16, 31, 33, 64]) {
      assert.throws(() => createSecretBox(Buffer.alloc(length)), Error, `chave de ${length} bytes`);
    }
  });
});

describe('deriveKey', () => {
  it('gera 32 bytes de forma determinística', () => {
    const a = deriveKey(KEY, 'ip-hash');
    assert.equal(a.length, 32);
    assert.ok(Buffer.isBuffer(a));
    assert.deepEqual(a, deriveKey(KEY, 'ip-hash'));
  });

  it('muda com o propósito e com a chave mestra', () => {
    const base = deriveKey(KEY, 'ip-hash').toString('hex');
    assert.notEqual(base, deriveKey(KEY, 'ip-hash2').toString('hex'));
    assert.notEqual(base, deriveKey(KEY, 'sessions').toString('hex'));
    assert.notEqual(base, deriveKey(KEY, '').toString('hex'));
    assert.notEqual(base, deriveKey(OTHER_KEY, 'ip-hash').toString('hex'));
    assert.notEqual(base, KEY.toString('hex'));
  });

  it('a subchave serve como chave de cifra', () => {
    const box = createSecretBox(deriveKey(KEY, 'secrets'));
    assert.equal(box.decrypt(box.encrypt('ok')), 'ok');
  });
});

describe('hashes', () => {
  it('hmacSha256Hex confere com o vetor da RFC 4231 (caso 2)', () => {
    assert.equal(
      hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('hmacSha256Base64 é o mesmo HMAC em base64', () => {
    const hex = hmacSha256Hex('Jefe', 'what do ya want for nothing?');
    assert.equal(hmacSha256Base64('Jefe', 'what do ya want for nothing?'), Buffer.from(hex, 'hex').toString('base64'));
  });

  it('aceita string ou Buffer na chave e nos dados', () => {
    const expected = hmacSha256Hex('chave', 'dados');
    assert.equal(hmacSha256Hex(Buffer.from('chave'), 'dados'), expected);
    assert.equal(hmacSha256Hex('chave', Buffer.from('dados')), expected);
    assert.equal(hmacSha256Base64(Buffer.from('chave'), Buffer.from('dados')), Buffer.from(expected, 'hex').toString('base64'));
    assert.notEqual(hmacSha256Hex('chave2', 'dados'), expected);
    assert.notEqual(hmacSha256Hex('chave', 'dados2'), expected);
  });

  it('sha256Hex confere com vetores conhecidos', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'));
  });
});

describe('timingSafeEqualStr', () => {
  it('compara o conteúdo', () => {
    assert.equal(timingSafeEqualStr('abc', 'abc'), true);
    assert.equal(timingSafeEqualStr('', ''), true);
    assert.equal(timingSafeEqualStr('senha-ção-🔐', 'senha-ção-🔐'), true);
    assert.equal(timingSafeEqualStr('abc', 'abd'), false);
    assert.equal(timingSafeEqualStr('abc', 'ABC'), false);
  });

  it('aceita tamanhos diferentes sem lançar', () => {
    assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
    assert.equal(timingSafeEqualStr('', 'a'), false);
    assert.equal(timingSafeEqualStr('a'.repeat(10_000), 'a'), false);
    assert.equal(timingSafeEqualStr('abc', 'abc\u0000'), false);
  });
});

describe('valores aleatórios', () => {
  it('randomId usa o prefixo e 24 caracteres hex', () => {
    assert.match(randomId('st'), /^st_[0-9a-f]{24}$/);
    assert.match(randomId('cs'), /^cs_[0-9a-f]{24}$/);
    const ids = new Set(Array.from({ length: 2000 }, () => randomId('ln')));
    assert.equal(ids.size, 2000);
  });

  it('randomToken é base64url com o tamanho pedido', () => {
    const token = randomToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(Buffer.from(randomToken(16), 'base64url').length, 16);
    assert.equal(Buffer.from(randomToken(48), 'base64url').length, 48);
    const tokens = new Set(Array.from({ length: 2000 }, () => randomToken()));
    assert.equal(tokens.size, 2000);
  });
});
