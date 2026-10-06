import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveLink } from '../src/checkout/routing.ts';
import type { Link } from '../src/types.ts';

function link(overrides: Partial<Link> & Pick<Link, 'id' | 'kind'>): Link {
  return {
    vitrineStoreId: 'st_v',
    checkoutStoreId: 'st_c',
    countries: [],
    enabled: true,
    parityPolicy: 'block',
    priceToleranceBps: 0,
    maxQuantityPerLine: 50,
    maxLines: 50,
    strategy: 'storefront_cart',
    allowPermalinkFallback: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const defaultLink = link({ id: 'ln_default', kind: 'default', checkoutStoreId: 'st_c1' });
const brLink = link({ id: 'ln_br', kind: 'country', countries: ['AR', 'BR'], checkoutStoreId: 'st_c2' });
const usLink = link({ id: 'ln_us', kind: 'country', countries: ['US'], checkoutStoreId: 'st_c3' });

describe('resolveLink', () => {
  it('rota por país vence a default', () => {
    assert.equal(resolveLink([defaultLink, brLink, usLink], 'BR')?.id, 'ln_br');
    assert.equal(resolveLink([defaultLink, brLink, usLink], 'AR')?.id, 'ln_br');
    assert.equal(resolveLink([defaultLink, brLink, usLink], 'US')?.id, 'ln_us');
  });

  it('país sem rota própria cai na default', () => {
    assert.equal(resolveLink([brLink, defaultLink], 'PT')?.id, 'ln_default');
  });

  it('sem país usa a default', () => {
    assert.equal(resolveLink([brLink, defaultLink], null)?.id, 'ln_default');
  });

  it('sem default e sem país correspondente não há rota', () => {
    assert.equal(resolveLink([brLink, usLink], 'PT'), null);
    assert.equal(resolveLink([brLink, usLink], null), null);
    assert.equal(resolveLink([], 'BR'), null);
  });

  it('rotas desativadas não participam, nem a por país nem a default', () => {
    const disabledBr = link({ ...brLink, enabled: false });
    assert.equal(resolveLink([defaultLink, disabledBr], 'BR')?.id, 'ln_default');
    const disabledDefault = link({ ...defaultLink, enabled: false });
    assert.equal(resolveLink([disabledDefault, brLink], 'PT'), null);
  });

  it('o país é comparado exatamente (já normalizado em maiúsculas)', () => {
    assert.equal(resolveLink([defaultLink, brLink], 'br')?.id, 'ln_default');
  });

  it('não altera a lista recebida e não depende da ordem dela', () => {
    const links = [usLink, defaultLink, brLink];
    const copy = [...links];
    assert.equal(resolveLink(links, 'BR')?.id, 'ln_br');
    assert.deepEqual(links, copy);
    assert.equal(resolveLink([brLink, defaultLink, usLink], 'BR')?.id, 'ln_br');
  });

  it('com duas rotas iguais (dado inconsistente) escolhe sempre a mais antiga', () => {
    const older = link({ id: 'ln_b', kind: 'default', createdAt: '2025-01-01T00:00:00.000Z' });
    const newer = link({ id: 'ln_a', kind: 'default', createdAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(resolveLink([newer, older], null)?.id, 'ln_b');
    assert.equal(resolveLink([older, newer], null)?.id, 'ln_b');
  });
});
