const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoSearchSignature,
  isUsableAutoSearchCache,
  shouldRunSourceForPerson
} = require('./server');

const eligiblePerson = (overrides = {}) => ({
  id: 'person-1',
  lastName: 'Иванов',
  name: 'Иван',
  middleName: 'Иванович',
  birthDate: '1900',
  birthPlace: 'Москва',
  information: '',
  ...overrides
});

test('auto-search source requirements match configured fields and year boundaries', () => {
  assert.equal(shouldRunSourceForPerson(eligiblePerson(), 'userTrees'), true);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ middleName: '' }), 'userTrees'), false);

  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1879' }), 'pamyatNaroda'), false);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1880' }), 'pamyatNaroda'), true);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1928-12-31' }), 'pamyatNaroda'), true);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1929' }), 'pamyatNaroda'), false);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ middleName: '' }), 'pamyatNaroda'), false);

  assert.equal(shouldRunSourceForPerson(eligiblePerson({ middleName: '', birthDate: '1850' }), 'openList'), true);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ middleName: '', birthDate: '1975' }), 'openList'), true);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1849' }), 'openList'), false);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1976' }), 'openList'), false);

  assert.equal(shouldRunSourceForPerson(eligiblePerson({ middleName: '', birthDate: '1850' }), 'gwar'), true);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ middleName: '', birthDate: '1900' }), 'gwar'), true);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1849' }), 'gwar'), false);
  assert.equal(shouldRunSourceForPerson(eligiblePerson({ birthDate: '1901' }), 'gwar'), false);
});

test('auto-search signature changes only when search input changes', () => {
  const person = eligiblePerson();
  const signature = buildAutoSearchSignature(person, 'openList');

  ['lastName', 'name', 'middleName', 'birthDate', 'birthPlace'].forEach((field) => {
    assert.notEqual(
      buildAutoSearchSignature({ ...person, [field]: `${person[field]} изменено` }, 'openList'),
      signature
    );
  });

  assert.equal(
    buildAutoSearchSignature({ ...person, information: 'Новая заметка' }, 'openList'),
    signature
  );
});

test('only current successful results are treated as usable cache', () => {
  const person = eligiblePerson();
  const signature = buildAutoSearchSignature(person, 'openList');
  const cache = {
    searchCriteria: { fullName: true, birthDate: true, birthPlace: true },
    autoSearchSignature: signature,
    matches: [],
    errors: []
  };

  assert.equal(isUsableAutoSearchCache(cache, signature, cache.searchCriteria), true);
  assert.equal(isUsableAutoSearchCache({ ...cache, errors: [{ message: 'temporary failure' }] }, signature, cache.searchCriteria), false);
  assert.equal(isUsableAutoSearchCache({ ...cache, autoSearchSignature: 'stale' }, signature, cache.searchCriteria), false);
  assert.equal(isUsableAutoSearchCache({ ...cache, matches: null }, signature, cache.searchCriteria), false);
});
