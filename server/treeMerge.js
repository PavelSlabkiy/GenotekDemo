// Слияние деревьев бережёт уже заполненные карточки и добавляет только недостающую родню.

const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const normalizeText = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const personIdentity = (person = {}) => [
  normalizeText(person.lastName),
  normalizeText(person.name),
  normalizeText(person.middleName),
  normalizeText(person.birthDate),
  normalizeText(person.birthPlace),
  normalizeText(person.gender)
].join('|');

const clonePeople = (people = {}) => Object.fromEntries(
  Object.entries(people).map(([id, person]) => {
    const clone = {
      ...person,
      children: [...(person.children || [])]
    };
    if (Array.isArray(person.mergedTreeRefs)) {
      clone.mergedTreeRefs = [...person.mergedTreeRefs];
    }
    return [id, clone];
  })
);

const addMergeRef = (person, treeId, sourcePersonId) => {
  const refs = Array.isArray(person.mergedTreeRefs) ? person.mergedTreeRefs : [];
  if (!refs.some((ref) => String(ref?.treeId) === treeId && String(ref?.personId) === sourcePersonId)) {
    refs.push({ treeId, personId: sourcePersonId });
  }
  person.mergedTreeRefs = refs;
};

const connectedSourceIds = (sourcePeople, anchorIds) => {
  const adjacency = {};
  Object.keys(sourcePeople).forEach((id) => {
    adjacency[id] = new Set();
  });
  Object.entries(sourcePeople).forEach(([id, person]) => {
    [person.fatherId, person.motherId, person.partnerId, ...(person.children || [])]
      .filter((relativeId) => relativeId && sourcePeople[relativeId])
      .forEach((relativeId) => {
        adjacency[id].add(relativeId);
        adjacency[relativeId].add(id);
      });
  });

  const visited = new Set();
  const queue = anchorIds.filter((id) => sourcePeople[id]);
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    adjacency[id].forEach((relativeId) => {
      if (!visited.has(relativeId)) queue.push(relativeId);
    });
  }
  return visited;
};

const mergeTreePeople = ({
  currentPeople,
  sourcePeople,
  treeId,
  matches,
  generateId
}) => {
  const normalizedTreeId = String(treeId || '');
  const people = clonePeople(currentPeople);
  const sourceToCurrent = new Map();
  const conflicts = [];

  Object.values(people).forEach((person) => {
    (person.mergedTreeRefs || []).forEach((ref) => {
      if (String(ref?.treeId) === normalizedTreeId && sourcePeople[String(ref?.personId)]) {
        sourceToCurrent.set(String(ref.personId), String(person.id));
      }
    });
  });

  const setMapping = (sourceId, currentId, reason) => {
    const normalizedSourceId = String(sourceId || '');
    const normalizedCurrentId = String(currentId || '');
    if (!sourcePeople[normalizedSourceId] || !people[normalizedCurrentId]) return false;
    const existing = sourceToCurrent.get(normalizedSourceId);
    if (existing && existing !== normalizedCurrentId) {
      conflicts.push({ sourceId: normalizedSourceId, currentId: normalizedCurrentId, existing, reason });
      return false;
    }
    if (existing) return false;
    sourceToCurrent.set(normalizedSourceId, normalizedCurrentId);
    return true;
  };

  (matches || []).forEach((match) => {
    setMapping(match?.database_id, match?.data_id, 'match');
  });

  const anchorIds = unique((matches || []).map((match) => String(match?.database_id || '')));
  const sourceIds = connectedSourceIds(sourcePeople, anchorIds);
  if (sourceIds.size === 0) {
    return { people, addedPersonIds: [], mappedPersonIds: [], conflicts };
  }

  let changed = true;
  while (changed) {
    changed = false;
    sourceToCurrent.forEach((currentId, sourceId) => {
      const source = sourcePeople[sourceId];
      const current = people[currentId];
      if (!source || !current || !sourceIds.has(sourceId)) return;

      [
        [source.fatherId, current.fatherId, 'father'],
        [source.motherId, current.motherId, 'mother'],
        [source.partnerId, current.partnerId, 'partner']
      ].forEach(([sourceRelativeId, currentRelativeId, reason]) => {
        if (sourceRelativeId && currentRelativeId && sourceIds.has(String(sourceRelativeId))) {
          changed = setMapping(sourceRelativeId, currentRelativeId, reason) || changed;
        }
      });

      const currentChildren = (current.children || []).map((id) => people[id]).filter(Boolean);
      (source.children || []).forEach((sourceChildId) => {
        const normalizedChildId = String(sourceChildId);
        if (!sourceIds.has(normalizedChildId) || sourceToCurrent.has(normalizedChildId)) return;
        const sourceChildIdentity = personIdentity(sourcePeople[normalizedChildId]);
        const candidates = currentChildren.filter((child) => personIdentity(child) === sourceChildIdentity);
        if (candidates.length === 1) {
          changed = setMapping(normalizedChildId, candidates[0].id, 'child') || changed;
        }
      });
    });
  }

  const addedPersonIds = [];
  sourceIds.forEach((sourceId) => {
    if (sourceToCurrent.has(sourceId)) return;
    let newId = String(generateId());
    while (people[newId]) newId = String(generateId());
    sourceToCurrent.set(sourceId, newId);
    addedPersonIds.push(newId);
  });

  sourceIds.forEach((sourceId) => {
    const source = sourcePeople[sourceId] || {};
    const currentId = sourceToCurrent.get(sourceId);
    const existing = people[currentId];
    const mappedFatherId = source.fatherId ? sourceToCurrent.get(String(source.fatherId)) || null : null;
    const mappedMotherId = source.motherId ? sourceToCurrent.get(String(source.motherId)) || null : null;
    const mappedPartnerId = source.partnerId ? sourceToCurrent.get(String(source.partnerId)) || null : null;
    const mappedChildren = (source.children || [])
      .map((childId) => sourceToCurrent.get(String(childId)))
      .filter(Boolean);

    if (existing) {
      if (!existing.fatherId && mappedFatherId) existing.fatherId = mappedFatherId;
      if (!existing.motherId && mappedMotherId) existing.motherId = mappedMotherId;
      if (!existing.partnerId && mappedPartnerId) existing.partnerId = mappedPartnerId;
      existing.children = unique([...(existing.children || []), ...mappedChildren]);
      addMergeRef(existing, normalizedTreeId, sourceId);
      return;
    }

    people[currentId] = {
      id: currentId,
      name: source.name || '',
      lastName: source.lastName || '',
      middleName: source.middleName || '',
      gender: source.gender || 'male',
      fatherId: mappedFatherId,
      motherId: mappedMotherId,
      partnerId: mappedPartnerId,
      children: unique(mappedChildren),
      isAlive: source.isAlive !== undefined ? source.isAlive : true,
      birthDate: source.birthDate || '',
      birthPlace: source.birthPlace || '',
      information: source.information || '',
      documents: Array.isArray(source.documents) ? source.documents : [],
      sourceSearchCache: {},
      hasMatch: false,
      mergedTreeRefs: [{ treeId: normalizedTreeId, personId: sourceId }]
    };
  });

  sourceIds.forEach((sourceId) => {
    const person = people[sourceToCurrent.get(sourceId)];
    if (!person) return;
    if (person.fatherId && people[person.fatherId]) {
      people[person.fatherId].children = unique([...(people[person.fatherId].children || []), person.id]);
    }
    if (person.motherId && people[person.motherId]) {
      people[person.motherId].children = unique([...(people[person.motherId].children || []), person.id]);
    }
    if (person.partnerId && people[person.partnerId] && !people[person.partnerId].partnerId) {
      people[person.partnerId].partnerId = person.id;
    }
  });

  return {
    people,
    addedPersonIds,
    mappedPersonIds: Array.from(sourceToCurrent.values()),
    conflicts
  };
};

const createTreeMergeOperation = ({
  operationId,
  treeId,
  matches,
  currentPeople,
  mergeResult,
  createdAt = new Date().toISOString()
}) => {
  const previousPeople = {};
  Object.entries(currentPeople || {}).forEach(([personId, person]) => {
    const mergedPerson = mergeResult.people?.[personId];
    const mergeChangedPerson = JSON.stringify(mergedPerson) !== JSON.stringify(person);
    const cacheWillChange = Object.values(person.sourceSearchCache || {}).some((cacheEntry) => (
      ['rawMatches', 'matches'].some((key) => (
        Array.isArray(cacheEntry?.[key])
        && cacheEntry[key].some((match) => String(match?.tree_id || '') === String(treeId))
      ))
    ));
    if (mergeChangedPerson || cacheWillChange) {
      previousPeople[personId] = cloneValue(person);
    }
  });

  return {
    id: String(operationId),
    treeId: String(treeId),
    status: 'merged',
    createdAt,
    undoneAt: null,
    matches: cloneValue(matches || []),
    addedPersonIds: [...(mergeResult.addedPersonIds || [])],
    affectedPersonIds: unique([
      ...Object.keys(previousPeople),
      ...(mergeResult.addedPersonIds || [])
    ]),
    previousPeople
  };
};

const undoTreeMergePeople = ({ currentPeople, operation }) => {
  const people = cloneValue(currentPeople || {});
  (operation?.addedPersonIds || []).forEach((personId) => {
    delete people[String(personId)];
  });
  Object.entries(operation?.previousPeople || {}).forEach(([personId, person]) => {
    people[String(personId)] = cloneValue(person);
  });
  return people;
};

module.exports = {
  createTreeMergeOperation,
  mergeTreePeople,
  undoTreeMergePeople
};
