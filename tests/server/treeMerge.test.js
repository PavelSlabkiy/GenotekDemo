const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTreeMergeOperation,
  mergeTreePeople,
  undoTreeMergePeople
} = require('../../server/treeMerge');

// Проверяем, что импорт чужой ветки не портит уже заполненное дерево.

const person = (id, overrides = {}) => ({
  id,
  name: id,
  lastName: '',
  middleName: '',
  gender: 'male',
  fatherId: null,
  motherId: null,
  partnerId: null,
  children: [],
  birthDate: '',
  birthPlace: '',
  ...overrides
});

test('merges missing relatives through multiple matched people without changing existing cards', () => {
  const currentPeople = {
    currentChild: person('currentChild', { name: 'Иван', fatherId: 'currentFather' }),
    currentFather: person('currentFather', { name: 'Петр', children: ['currentChild'], information: 'keep me' })
  };
  const sourcePeople = {
    sourceChild: person('sourceChild', { name: 'Иван', fatherId: 'sourceFather', motherId: 'sourceMother' }),
    sourceFather: person('sourceFather', { name: 'Петр', partnerId: 'sourceMother', children: ['sourceChild'] }),
    sourceMother: person('sourceMother', { name: 'Анна', partnerId: 'sourceFather', children: ['sourceChild'], fatherId: 'sourceGrandfather' }),
    sourceGrandfather: person('sourceGrandfather', { name: 'Сергей', children: ['sourceMother'] }),
    disconnected: person('disconnected', { name: 'Не родственник' })
  };
  let counter = 0;

  const result = mergeTreePeople({
    currentPeople,
    sourcePeople,
    treeId: 'tree-b',
    matches: [
      { data_id: 'currentChild', database_id: 'sourceChild' },
      { data_id: 'currentFather', database_id: 'sourceFather' }
    ],
    generateId: () => `new-${++counter}`
  });

  assert.equal(result.addedPersonIds.length, 2);
  assert.deepEqual(
    new Set(result.mappedPersonIds),
    new Set(['currentChild', 'currentFather', 'new-1', 'new-2'])
  );
  assert.equal(result.people.currentFather.information, 'keep me');
  assert.equal(result.people.currentChild.fatherId, 'currentFather');
  assert.equal(result.people.currentChild.motherId, 'new-1');
  assert.equal(result.people['new-1'].fatherId, 'new-2');
  assert.equal(result.people['new-1'].partnerId, 'currentFather');
  assert.deepEqual(result.people['new-2'].children, ['new-1']);
  assert.equal(Object.values(result.people).some((item) => item.name === 'Не родственник'), false);
});

test('repeated merge is idempotent', () => {
  const sourcePeople = {
    sourceChild: person('sourceChild', { fatherId: 'sourceFather' }),
    sourceFather: person('sourceFather', { children: ['sourceChild'] })
  };
  let counter = 0;
  const first = mergeTreePeople({
    currentPeople: { currentChild: person('currentChild') },
    sourcePeople,
    treeId: 'tree-b',
    matches: [{ data_id: 'currentChild', database_id: 'sourceChild' }],
    generateId: () => `new-${++counter}`
  });
  const second = mergeTreePeople({
    currentPeople: first.people,
    sourcePeople,
    treeId: 'tree-b',
    matches: [{ data_id: 'currentChild', database_id: 'sourceChild' }],
    generateId: () => `new-${++counter}`
  });

  assert.equal(first.addedPersonIds.length, 1);
  assert.equal(second.addedPersonIds.length, 0);
  assert.deepEqual(new Set(second.mappedPersonIds), new Set(['currentChild', 'new-1']));
  assert.equal(Object.keys(second.people).length, 2);
});

test('undo restores existing cards and removes only people added by the merge', () => {
  const currentPeople = {
    currentChild: person('currentChild', { fatherId: 'currentFather' }),
    currentFather: person('currentFather', { information: 'keep me' }),
    unrelated: person('unrelated', { information: 'untouched' })
  };
  const sourcePeople = {
    sourceChild: person('sourceChild', { motherId: 'sourceMother' }),
    sourceMother: person('sourceMother', { children: ['sourceChild'] })
  };
  let counter = 0;
  const mergeResult = mergeTreePeople({
    currentPeople,
    sourcePeople,
    treeId: 'tree-b',
    matches: [{ data_id: 'currentChild', database_id: 'sourceChild' }],
    generateId: () => `new-${++counter}`
  });
  const operation = createTreeMergeOperation({
    operationId: 'operation-1',
    treeId: 'tree-b',
    matches: [{ data_id: 'currentChild', database_id: 'sourceChild' }],
    currentPeople,
    mergeResult
  });
  mergeResult.people.currentFather.information = 'changed after merge';

  const restored = undoTreeMergePeople({
    currentPeople: mergeResult.people,
    operation
  });

  assert.deepEqual(restored.currentChild, currentPeople.currentChild);
  assert.deepEqual(restored.currentFather, currentPeople.currentFather);
  assert.deepEqual(restored.unrelated, currentPeople.unrelated);
  assert.equal(restored['new-1'], undefined);
});
