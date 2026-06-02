const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const DATABASE_FILE = path.join(__dirname, '..', 'database.json');
const TREES_DIR = path.join(__dirname, '..', 'trees');
const PAMYAT_PARSER_SCRIPT = path.join(__dirname, '..', 'pamyat_parser.py');
const OPENLIST_PARSER_SCRIPT = path.join(__dirname, '..', 'openlist_parser.py');
const GWAR_PARSER_SCRIPT = path.join(__dirname, '..', 'gwar_parser.py');
const SMART_MATCHING_SCRIPT = path.join(__dirname, '..', 'smart_matching.py');

const getOid = (value) => {
  if (value && typeof value === 'object' && '$oid' in value) {
    return String(value.$oid);
  }
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
};

const toOidObject = (value) => ({ $oid: String(value) });

const firstString = (value) => {
  if (Array.isArray(value)) return value[0] || '';
  if (typeof value === 'string') return value;
  return '';
};

const normalizeGenderToApp = (gender) => {
  if (!gender) return 'male';
  const normalized = String(gender).toLowerCase();
  if (normalized.startsWith('f')) return 'female';
  return 'male';
};

const normalizeGenderToStorage = (gender) => (
  String(gender).toLowerCase() === 'female' ? 'Female' : 'Male'
);

const birthDateToApp = (birthdate) => {
  if (!Array.isArray(birthdate) || birthdate.length === 0) return '';
  const raw = birthdate[0] || {};
  const year = raw.year;
  const month = raw.month;
  const day = raw.day;

  if (!year) return '';
  if (!month) return String(year);
  if (!day) return `${String(year)}-${String(month).padStart(2, '0')}`;
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const birthDateToStorage = (birthDate) => {
  if (!birthDate) return [];
  const parts = String(birthDate).split('-');
  const year = Number(parts[0]) || null;
  const month = parts[1] ? Number(parts[1]) : null;
  const day = parts[2] ? Number(parts[2]) : null;

  if (!year) return [];
  return [{ day, month, year }];
};

const isAliveFromStorage = (raw) => {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  return String(raw) !== '0';
};

const liveOrDeadFromApp = (isAlive) => (isAlive ? 1 : 0);

const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const PAMYAT_SOURCE_KEY = 'pamyatNaroda';
const OPENLIST_SOURCE_KEY = 'openList';
const GWAR_SOURCE_KEY = 'gwar';
const USER_TREES_SOURCE_KEY = 'userTrees';
const DEFAULT_SMART_SEARCH_CRITERIA = {
  fullName: true,
  birthDate: true,
  birthPlace: true
};
const AUTO_SMART_SEARCH_CRITERIA = {
  fullName: true,
  birthDate: true,
  birthPlace: true
};

const hasValue = (value) => Boolean(String(value || '').trim());
const extractBirthYear = (birthDate = '') => {
  const match = String(birthDate).match(/^\s*(\d{4})/);
  return match ? Number(match[1]) : null;
};
const isYearInRange = (year, leftBound, rightBound) => {
  if (!Number.isFinite(year)) return false;
  const min = Math.min(leftBound, rightBound);
  const max = Math.max(leftBound, rightBound);
  return year >= min && year <= max;
};

const AUTO_SOURCE_REQUIREMENTS = {
  [USER_TREES_SOURCE_KEY]: {
    key: USER_TREES_SOURCE_KEY,
    hasRequiredFields: (person) => (
      hasValue(person?.lastName)
      && hasValue(person?.name)
      && hasValue(person?.middleName)
      && hasValue(person?.birthDate)
      && hasValue(person?.birthPlace)
    )
  },
  [PAMYAT_SOURCE_KEY]: {
    key: PAMYAT_SOURCE_KEY,
    hasRequiredFields: (person) => (
      hasValue(person?.lastName)
      && hasValue(person?.name)
      && hasValue(person?.middleName)
      && hasValue(person?.birthDate)
      && hasValue(person?.birthPlace)
      && isYearInRange(extractBirthYear(person?.birthDate), 1880, 1820)
    )
  },
  [OPENLIST_SOURCE_KEY]: {
    key: OPENLIST_SOURCE_KEY,
    hasRequiredFields: (person) => (
      hasValue(person?.lastName)
      && hasValue(person?.name)
      && hasValue(person?.birthDate)
      && hasValue(person?.birthPlace)
      && isYearInRange(extractBirthYear(person?.birthDate), 1850, 1975)
    )
  },
  [GWAR_SOURCE_KEY]: {
    key: GWAR_SOURCE_KEY,
    hasRequiredFields: (person) => (
      hasValue(person?.lastName)
      && hasValue(person?.name)
      && hasValue(person?.birthDate)
      && hasValue(person?.birthPlace)
      && isYearInRange(extractBirthYear(person?.birthDate), 1850, 1900)
    )
  }
};

const buildAutoSearchSignature = (person = {}, sourceKey) => {
  const signaturePayload = {
    sourceKey,
    lastName: person.lastName || '',
    name: person.name || '',
    middleName: person.middleName || '',
    birthDate: person.birthDate || '',
    birthPlace: person.birthPlace || ''
  };
  return JSON.stringify(signaturePayload);
};

const normalizeSearchCriteria = (rawCriteria = {}) => ({
  fullName: rawCriteria?.fullName !== false,
  birthDate: rawCriteria?.birthDate !== false,
  birthPlace: rawCriteria?.birthPlace !== false
});

const areSearchCriteriaEqual = (left, right) => {
  const normalizedLeft = normalizeSearchCriteria(left);
  const normalizedRight = normalizeSearchCriteria(right);
  return normalizedLeft.fullName === normalizedRight.fullName
    && normalizedLeft.birthDate === normalizedRight.birthDate
    && normalizedLeft.birthPlace === normalizedRight.birthPlace;
};

const relationshipTemplate = (partnerId) => ({
  with: toOidObject(partnerId),
  type: 'official',
  finished: null,
  from: [{ day: null, month: null, year: null }],
  to: [{ day: null, month: null, year: null }]
});

const calculatePersonHasMatch = (person) => {
  const sourceSearchCache = person?.sourceSearchCache || {};
  return Object.values(sourceSearchCache).some((cacheEntry) => (
    cacheEntry && typeof cacheEntry === 'object' && Array.isArray(cacheEntry.matches) && cacheEntry.matches.length > 0
  ));
};

const deriveTreeOwner = (entries) => {
  if (!entries.length) return 'Unknown';
  const ownerWithPatient = entries.find(entry => entry.patientId);
  const source = ownerWithPatient || entries[0];
  return [firstString(source.surname), firstString(source.name), firstString(source.middleName)]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Unknown';
};

const parseLegacyPeopleMapToEntries = (peopleMap, treeId = 'tree-main') => {
  const people = Object.values(peopleMap || {});
  return people.map((person) => {
    const relatives = [];
    if (person.fatherId) relatives.push({ id: toOidObject(person.fatherId), relationType: 'parent' });
    if (person.motherId) relatives.push({ id: toOidObject(person.motherId), relationType: 'parent' });
    if (person.partnerId) relatives.push({ id: toOidObject(person.partnerId), relationType: 'spouse' });
    (person.children || []).forEach(childId => {
      relatives.push({ id: toOidObject(childId), relationType: 'child' });
    });

    const entry = {
      _id: toOidObject(person.id),
      treeId: toOidObject(treeId),
      gender: normalizeGenderToStorage(person.gender),
      relatives,
      relationships: person.partnerId ? [relationshipTemplate(person.partnerId)] : [],
      birthdate: birthDateToStorage(person.birthDate),
      birthplace: person.birthPlace ? [person.birthPlace] : [],
      name: person.name ? [person.name] : [],
      surname: person.lastName ? [person.lastName] : [],
      middleName: person.middleName ? [person.middleName] : [],
      liveOrDead: liveOrDeadFromApp(person.isAlive !== false)
    };

    if (person.information) {
      entry.information = person.information;
    }
    if (Array.isArray(person.documents) && person.documents.length > 0) {
      entry.documents = person.documents;
    }
    return entry;
  });
};

const parseDatabaseFile = () => {
  try {
    const data = fs.readFileSync(DATABASE_FILE, 'utf8');
    const parsed = JSON.parse(data);

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed?.people) {
      const converted = parseLegacyPeopleMapToEntries(parsed.people, 'tree-main');
      fs.writeFileSync(DATABASE_FILE, JSON.stringify(converted, null, 2), 'utf8');
      return converted;
    }

    if (parsed?.tree_id) {
      const entries = [];
      Object.entries(parsed.tree_id).forEach(([treeId, treeData]) => {
        const treeEntries = parseLegacyPeopleMapToEntries(treeData.people || {}, treeId);
        entries.push(...treeEntries);
      });
      fs.writeFileSync(DATABASE_FILE, JSON.stringify(entries, null, 2), 'utf8');
      return entries;
    }

    return [];
  } catch (error) {
    console.error('Error reading database file:', error);
    return [];
  }
};

const groupEntriesByTree = (entries) => {
  const grouped = {};
  entries.forEach((entry) => {
    const treeId = getOid(entry.treeId) || 'tree-main';
    if (!grouped[treeId]) grouped[treeId] = [];
    grouped[treeId].push(entry);
  });
  return grouped;
};

const detectCurrentTreeId = (groupedTrees) => {
  const treeIds = Object.keys(groupedTrees);
  if (treeIds.length === 0) return 'tree-main';
  const withPatient = treeIds.find(treeId =>
    (groupedTrees[treeId] || []).some(entry => entry.patientId)
  );
  return withPatient || treeIds[0];
};

const buildPeopleFromEntries = (entries) => {
  const people = {};
  const parentCandidates = {};
  const childCandidates = {};
  const partnerCandidates = {};

  entries.forEach((entry) => {
    const id = getOid(entry._id);
    if (!id) return;

    people[id] = {
      id,
      name: firstString(entry.name),
      lastName: firstString(entry.surname),
      middleName: firstString(entry.middleName),
      gender: normalizeGenderToApp(entry.gender),
      fatherId: null,
      motherId: null,
      partnerId: null,
      children: [],
      isAlive: isAliveFromStorage(entry.liveOrDead),
      birthDate: birthDateToApp(entry.birthdate),
      birthPlace: firstString(entry.birthplace),
      hasMatch: Boolean(entry.hasMatch),
      sourceSearchCache: entry.sourceSearchCache || {},
      information: entry.information || '',
      documents: Array.isArray(entry.documents) ? entry.documents : []
    };
    people[id].hasMatch = calculatePersonHasMatch(people[id]) || people[id].hasMatch;
  });

  entries.forEach((entry) => {
    const id = getOid(entry._id);
    if (!id || !Array.isArray(entry.relatives)) return;

    entry.relatives.forEach((relative) => {
      const relativeId = getOid(relative?.id);
      if (!relativeId || !people[relativeId]) return;
      const relationType = relative.relationType;

      if (relationType === 'parent') {
        if (!parentCandidates[id]) parentCandidates[id] = [];
        parentCandidates[id].push(relativeId);
      } else if (relationType === 'child') {
        if (!childCandidates[id]) childCandidates[id] = [];
        childCandidates[id].push(relativeId);
      } else if (relationType === 'spouse') {
        partnerCandidates[id] = relativeId;
      }
    });
  });

  Object.entries(parentCandidates).forEach(([personId, parentIds]) => {
    const person = people[personId];
    const uniqueParents = unique(parentIds);

    uniqueParents.forEach((parentId) => {
      const parent = people[parentId];
      if (!parent) return;

      if (parent.gender === 'male' && !person.fatherId) {
        person.fatherId = parentId;
        return;
      }
      if (parent.gender === 'female' && !person.motherId) {
        person.motherId = parentId;
        return;
      }
      if (!person.fatherId) {
        person.fatherId = parentId;
        return;
      }
      if (!person.motherId) {
        person.motherId = parentId;
      }
    });
  });

  Object.entries(childCandidates).forEach(([personId, childIds]) => {
    people[personId].children = unique(childIds);
  });

  Object.entries(partnerCandidates).forEach(([personId, partnerId]) => {
    if (!people[personId] || !people[partnerId]) return;
    people[personId].partnerId = partnerId;
  });

  Object.values(people).forEach((person) => {
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

  return people;
};

const buildSmartMatchingDatabase = (groupedTrees, currentTreeId) => {
  const treeData = {};
  Object.entries(groupedTrees).forEach(([treeId, entries]) => {
    if (treeId === currentTreeId) return;
    treeData[treeId] = {
      tree_owner: deriveTreeOwner(entries),
      people: buildPeopleFromEntries(entries)
    };
  });
  return { tree_id: treeData };
};

const readExternalTreeEntries = () => {
  if (!fs.existsSync(TREES_DIR)) return [];
  let files = [];
  try {
    files = fs.readdirSync(TREES_DIR).filter(name => name.toLowerCase().endsWith('.json'));
  } catch (error) {
    console.error('Failed to read trees directory:', error);
    return [];
  }

  const entries = [];
  files.forEach((fileName) => {
    const filePath = path.join(TREES_DIR, fileName);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries.push(...parsed);
      } else {
        console.warn(`Skipping non-array tree file: ${fileName}`);
      }
    } catch (error) {
      console.error(`Failed to parse tree file ${fileName}:`, error);
    }
  });

  return entries;
};

const buildTreesDirectorySmartDatabase = () => {
  const externalEntries = readExternalTreeEntries();
  const grouped = groupEntriesByTree(externalEntries);
  const treeData = {};
  Object.entries(grouped).forEach(([treeId, entries]) => {
    treeData[treeId] = {
      tree_owner: deriveTreeOwner(entries),
      people: buildPeopleFromEntries(entries)
    };
  });
  return { tree_id: treeData };
};

const readDatabaseState = () => {
  const entries = parseDatabaseFile();
  const groupedTrees = groupEntriesByTree(entries);
  const currentTreeId = detectCurrentTreeId(groupedTrees);
  const currentEntries = groupedTrees[currentTreeId] || [];

  return {
    entries,
    groupedTrees,
    currentTreeId,
    currentEntries,
    people: buildPeopleFromEntries(currentEntries),
    smartMatchingDatabase: buildSmartMatchingDatabase(groupedTrees, currentTreeId)
  };
};

const buildRelativesFromPerson = (person) => {
  const relatives = [];
  if (person.fatherId) relatives.push({ id: toOidObject(person.fatherId), relationType: 'parent' });
  if (person.motherId) relatives.push({ id: toOidObject(person.motherId), relationType: 'parent' });
  if (person.partnerId) relatives.push({ id: toOidObject(person.partnerId), relationType: 'spouse' });
  (person.children || []).forEach((childId) => {
    relatives.push({ id: toOidObject(childId), relationType: 'child' });
  });

  const seen = new Set();
  return relatives.filter((relative) => {
    const key = `${getOid(relative.id)}-${relative.relationType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const convertPeopleToEntries = (people, treeId, existingEntries = []) => {
  const existingById = {};
  existingEntries.forEach((entry) => {
    const id = getOid(entry._id);
    if (id) existingById[id] = entry;
  });

  return Object.values(people).map((person) => {
    const base = existingById[person.id] ? { ...existingById[person.id] } : {};
    const entry = {
      ...base,
      _id: toOidObject(person.id),
      treeId: toOidObject(treeId),
      gender: normalizeGenderToStorage(person.gender),
      relatives: buildRelativesFromPerson(person),
      relationships: person.partnerId ? [relationshipTemplate(person.partnerId)] : [],
      birthdate: birthDateToStorage(person.birthDate),
      birthplace: person.birthPlace ? [person.birthPlace] : [],
      name: person.name ? [person.name] : [],
      surname: person.lastName ? [person.lastName] : [],
      middleName: person.middleName ? [person.middleName] : [],
      liveOrDead: liveOrDeadFromApp(person.isAlive !== false),
      hasMatch: calculatePersonHasMatch(person) || Boolean(person.hasMatch),
      sourceSearchCache: person.sourceSearchCache || base.sourceSearchCache || {}
    };

    if (person.information) {
      entry.information = person.information;
    } else {
      delete entry.information;
    }

    if (Array.isArray(person.documents) && person.documents.length > 0) {
      entry.documents = person.documents;
    } else {
      delete entry.documents;
    }

    return entry;
  });
};

const writeDatabaseEntries = (entries) => {
  try {
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(entries, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing database file:', error);
    return false;
  }
};

const writeCurrentPeople = (people) => {
  const state = readDatabaseState();
  const otherEntries = state.entries.filter(
    entry => (getOid(entry.treeId) || 'tree-main') !== state.currentTreeId
  );
  const currentEntries = convertPeopleToEntries(people, state.currentTreeId, state.currentEntries);
  return writeDatabaseEntries([...otherEntries, ...currentEntries]);
};

const generateId = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const buildEmptySourceResult = ({ sourceKey, sourceLabel, personIds }) => ({
  source: sourceKey,
  sourceLabel,
  matches: [],
  matchedDataIds: [],
  processedPersonIds: personIds || [],
  errors: []
});

const runSourceParser = ({ scriptPath, sourceKey, sourceLabel, people, personIds, searchCriteria }) => {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', [scriptPath], {
      timeout: 120000
    });
    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      const fallback = buildEmptySourceResult({ sourceKey, sourceLabel, personIds });
      let parsedStdout = null;
      if (stdout.trim()) {
        try {
          parsedStdout = JSON.parse(stdout);
        } catch (error) {
          parsedStdout = null;
        }
      }

      if (code !== 0) {
        console.error(`${sourceLabel} parser stderr:`, stderr || '(empty)');
        if (parsedStdout && typeof parsedStdout === 'object') {
          resolve(parsedStdout);
          return;
        }
        fallback.errors.push({ person_id: null, message: `Parser failed with code ${code}` });
        resolve(fallback);
        return;
      }

      if (parsedStdout && typeof parsedStdout === 'object') {
        resolve(parsedStdout);
      } else {
        console.error(`Failed to parse ${sourceKey} parser output:`, stdout);
        fallback.errors.push({ person_id: null, message: 'Failed to parse parser output JSON' });
        resolve(fallback);
      }
    });

    python.on('error', (err) => {
      console.error(`${sourceLabel} parser error:`, err);
      reject(err);
    });

    const input = JSON.stringify({
      people,
      personIds,
      searchCriteria: normalizeSearchCriteria(searchCriteria),
      maxRecordsPerPerson: 5,
      scoreThreshold: 70
    });
    python.stdin.write(input);
    python.stdin.end();
  });
};

// Run pamyat parser in app-search mode
const runPamyatParser = ({ people, personIds, searchCriteria }) => {
  return runSourceParser({
    scriptPath: PAMYAT_PARSER_SCRIPT,
    sourceKey: PAMYAT_SOURCE_KEY,
    sourceLabel: 'Память народа',
    people,
    personIds,
    searchCriteria
  });
};

const runOpenlistParser = ({ people, personIds, searchCriteria }) => {
  return runSourceParser({
    scriptPath: OPENLIST_PARSER_SCRIPT,
    sourceKey: OPENLIST_SOURCE_KEY,
    sourceLabel: 'Открытый список',
    people,
    personIds,
    searchCriteria
  });
};

const runGwarParser = ({ people, personIds, searchCriteria }) => {
  return runSourceParser({
    scriptPath: GWAR_PARSER_SCRIPT,
    sourceKey: GWAR_SOURCE_KEY,
    sourceLabel: 'Герои великой войны',
    people,
    personIds,
    searchCriteria
  });
};

const runTreeMatchingParser = ({ people, personIds, searchCriteria }) => {
  return new Promise((resolve, reject) => {
    const fallback = {
      matches: [],
      matchedDataIds: [],
      processedPersonIds: personIds || [],
      errors: []
    };
    const treesDatabase = buildTreesDirectorySmartDatabase();
    const treesCount = Object.keys(treesDatabase.tree_id || {}).length;
    if (treesCount === 0) {
      resolve(fallback);
      return;
    }

    const python = spawn('python3', [SMART_MATCHING_SCRIPT], {
      timeout: 120000
    });
    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        console.error('Smart matching parser stderr:', stderr || '(empty)');
        fallback.errors.push({ person_id: null, message: `Parser failed with code ${code}` });
        resolve(fallback);
        return;
      }

      if (!stdout.trim()) {
        resolve(fallback);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed && typeof parsed === 'object' ? parsed : fallback);
      } catch (error) {
        console.error('Failed to parse smart matching parser output:', error);
        fallback.errors.push({ person_id: null, message: 'Failed to parse parser output JSON' });
        resolve(fallback);
      }
    });

    python.on('error', (err) => {
      console.error('Smart matching parser error:', err);
      reject(err);
    });

    const input = JSON.stringify({
      data: { people },
      db: treesDatabase,
      personIds,
      searchCriteria: normalizeSearchCriteria(searchCriteria),
      scoreThreshold: 90,
      topKPerPerson: 5
    });
    python.stdin.write(input);
    python.stdin.end();
  });
};

// API Routes

// Get all people
app.get('/api/people', (req, res) => {
  const state = readDatabaseState();
  res.json(state.people);
});

// Get single person by ID
app.get('/api/people/:id', (req, res) => {
  const state = readDatabaseState();
  const person = state.people[req.params.id];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  res.json(person);
});

// Create new person
app.post('/api/people', async (req, res) => {
  const state = readDatabaseState();
  const people = { ...state.people };
  const newPerson = {
    id: req.body.id || generateId(),
    name: req.body.name || '',
    lastName: req.body.lastName || '',
    middleName: req.body.middleName || '',
    gender: req.body.gender || 'male',
    fatherId: req.body.fatherId || null,
    motherId: req.body.motherId || null,
    partnerId: req.body.partnerId || null,
    children: req.body.children || [],
    isAlive: req.body.isAlive !== undefined ? req.body.isAlive : true,
    birthDate: req.body.birthDate || '',
    birthPlace: req.body.birthPlace || '',
    hasMatch: req.body.hasMatch || false,
    information: req.body.information || '',
    documents: Array.isArray(req.body.documents) ? req.body.documents : []
  };

  people[newPerson.id] = newPerson;

  await runSmartMatchingForPeople({
    people,
    personIds: [newPerson.id],
    searchCriteria: AUTO_SMART_SEARCH_CRITERIA
  });

  if (writeCurrentPeople(people)) {
    res.status(201).json(newPerson);
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Update person
app.put('/api/people/:id', async (req, res) => {
  const state = readDatabaseState();
  const people = { ...state.people };
  const person = people[req.params.id];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  // Update person fields
  const updatedPerson = {
    ...person,
    ...req.body,
    id: req.params.id // Ensure ID doesn't change
  };
  
  people[req.params.id] = updatedPerson;

  await runSmartMatchingForPeople({
    people,
    personIds: [updatedPerson.id],
    searchCriteria: AUTO_SMART_SEARCH_CRITERIA
  });

  if (writeCurrentPeople(people)) {
    res.json(updatedPerson);
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Delete person
app.delete('/api/people/:id', (req, res) => {
  const state = readDatabaseState();
  const people = { ...state.people };
  const personId = req.params.id;
  const person = people[personId];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  // Remove references to this person from other people
  Object.values(people).forEach((p) => {
    // Remove from partner
    if (p.partnerId === personId) {
      p.partnerId = null;
    }
    
    // Remove from parent references
    if (p.fatherId === personId) {
      p.fatherId = null;
    }
    if (p.motherId === personId) {
      p.motherId = null;
    }
    
    // Remove from children arrays
    if (p.children && p.children.includes(personId)) {
      p.children = p.children.filter(id => id !== personId);
    }
  });
  
  // Delete the person
  delete people[personId];

  if (writeCurrentPeople(people)) {
    res.json({ success: true, message: 'Person deleted successfully' });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Add relative to a person
app.post('/api/people/:id/relative', async (req, res) => {
  const state = readDatabaseState();
  const people = { ...state.people };
  const personId = req.params.id;
  const person = people[personId];
  const { relationType, relativeData } = req.body;
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  const newRelativeId = generateId();
  const newRelative = {
    id: newRelativeId,
    name: relativeData.name || '',
    lastName: relativeData.lastName || '',
    middleName: relativeData.middleName || '',
    gender: relativeData.gender || 'male',
    fatherId: null,
    motherId: null,
    partnerId: null,
    children: [],
    isAlive: true,
    birthDate: relativeData.birthDate || '',
    birthPlace: relativeData.birthPlace || '',
    hasMatch: false,
    information: relativeData.information || '',
    documents: Array.isArray(relativeData.documents) ? relativeData.documents : []
  };
  
  switch (relationType) {
    case 'partner':
      newRelative.gender = person.gender === 'male' ? 'female' : 'male';
      newRelative.partnerId = personId;
      newRelative.children = [...(person.children || [])];
      person.partnerId = newRelativeId;
      break;
      
    case 'father':
      newRelative.gender = 'male';
      if (!newRelative.children.includes(personId)) {
        newRelative.children.push(personId);
      }
      person.fatherId = newRelativeId;
      // If mother exists, link father as partner
      if (person.motherId && people[person.motherId]) {
        newRelative.partnerId = person.motherId;
        people[person.motherId].partnerId = newRelativeId;
      }
      break;
      
    case 'mother':
      newRelative.gender = 'female';
      if (!newRelative.children.includes(personId)) {
        newRelative.children.push(personId);
      }
      person.motherId = newRelativeId;
      // If father exists, link mother as partner
      if (person.fatherId && people[person.fatherId]) {
        newRelative.partnerId = person.fatherId;
        people[person.fatherId].partnerId = newRelativeId;
      }
      break;
      
    case 'son':
      newRelative.gender = 'male';
      if (person.gender === 'male') {
        newRelative.fatherId = personId;
        if (person.partnerId) {
          newRelative.motherId = person.partnerId;
          if (people[person.partnerId]) {
            people[person.partnerId].children.push(newRelativeId);
          }
        }
      } else {
        newRelative.motherId = personId;
        if (person.partnerId) {
          newRelative.fatherId = person.partnerId;
          if (people[person.partnerId]) {
            people[person.partnerId].children.push(newRelativeId);
          }
        }
      }
      person.children.push(newRelativeId);
      break;
      
    case 'daughter':
      newRelative.gender = 'female';
      if (person.gender === 'male') {
        newRelative.fatherId = personId;
        if (person.partnerId) {
          newRelative.motherId = person.partnerId;
          if (people[person.partnerId]) {
            people[person.partnerId].children.push(newRelativeId);
          }
        }
      } else {
        newRelative.motherId = personId;
        if (person.partnerId) {
          newRelative.fatherId = person.partnerId;
          if (people[person.partnerId]) {
            people[person.partnerId].children.push(newRelativeId);
          }
        }
      }
      person.children.push(newRelativeId);
      break;
      
    default:
      return res.status(400).json({ error: 'Invalid relation type' });
  }
  
  people[newRelativeId] = newRelative;
  people[personId] = person;

  await runSmartMatchingForPeople({
    people,
    personIds: [personId, newRelativeId],
    searchCriteria: AUTO_SMART_SEARCH_CRITERIA
  });

  if (writeCurrentPeople(people)) {
    res.status(201).json({ person, newRelative });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Get person with full family info (for card display)
app.get('/api/people/:id/family', (req, res) => {
  const state = readDatabaseState();
  const people = state.people;
  const person = people[req.params.id];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  const getFullName = (p) => {
    if (!p) return null;
    return `${p.lastName || ''} ${p.name || ''} ${p.middleName || ''}`.trim();
  };
  
  const getPersonInfo = (id) => {
    const p = people[id];
    if (!p) return null;
    return {
      id: p.id,
      fullName: getFullName(p),
      gender: p.gender
    };
  };
  
  // Get siblings (people with same parents)
  const siblings = [];
  Object.values(people).forEach(p => {
    if (p.id !== person.id) {
      const samefather = person.fatherId && p.fatherId === person.fatherId;
      const sameMother = person.motherId && p.motherId === person.motherId;
      if (samefather || sameMother) {
        siblings.push(getPersonInfo(p.id));
      }
    }
  });
  
  const familyInfo = {
    ...person,
    fullName: getFullName(person),
    partner: person.partnerId ? getPersonInfo(person.partnerId) : null,
    father: person.fatherId ? getPersonInfo(person.fatherId) : null,
    mother: person.motherId ? getPersonInfo(person.motherId) : null,
    childrenInfo: (person.children || []).map(id => getPersonInfo(id)).filter(Boolean),
    siblings
  };
  
  res.json(familyInfo);
});

const sourceCacheEntry = ({ sourceKey, sourceLabel, matches, errors = [], searchCriteria }) => ({
  searchedAt: new Date().toISOString(),
  status: matches.length > 0 ? 'matches_found' : 'no_matches',
  source: sourceKey,
  sourceLabel,
  searchCriteria: normalizeSearchCriteria(searchCriteria),
  matches,
  errors
});

const normalizePersonIds = (personIds, people) => {
  if (!Array.isArray(personIds) || personIds.length === 0) {
    return Object.keys(people);
  }
  const peopleSet = new Set(Object.keys(people));
  return [...new Set(personIds.map(String).filter(id => peopleSet.has(id)))];
};

const SUPPORTED_SMART_SOURCES = [
  {
    key: PAMYAT_SOURCE_KEY,
    label: 'Память народа',
    enabledByDefault: true,
    parser: runPamyatParser
  },
  {
    key: OPENLIST_SOURCE_KEY,
    label: 'Открытый список',
    enabledByDefault: true,
    parser: runOpenlistParser
  },
  {
    key: GWAR_SOURCE_KEY,
    label: 'Герои великой войны',
    enabledByDefault: true,
    parser: runGwarParser
  }
];

const USER_TREES_SOURCE = {
  key: USER_TREES_SOURCE_KEY,
  label: 'Деревья других пользователей',
  enabledByDefault: true
};

const shouldRunSourceForPerson = (person, sourceKey) => {
  const requirement = AUTO_SOURCE_REQUIREMENTS[sourceKey];
  if (!requirement) return false;
  return requirement.hasRequiredFields(person);
};

const runSmartMatchingForPeople = async ({ people, personIds, searchCriteria = AUTO_SMART_SEARCH_CRITERIA }) => {
  const normalizedPersonIds = normalizePersonIds(personIds, people);
  if (!normalizedPersonIds.length) {
    return { people, processedPersonIds: [] };
  }

  let treeParserResult = {
    matches: [],
    errors: [],
    matchedDataIds: [],
    processedPersonIds: normalizedPersonIds
  };

  const treePersonIds = normalizedPersonIds.filter((personId) => (
    shouldRunSourceForPerson(people[personId], USER_TREES_SOURCE_KEY)
  ));
  if (treePersonIds.length > 0) {
    treeParserResult = await runTreeMatchingParser({
      people,
      personIds: treePersonIds,
      searchCriteria
    });
  }

  const treeMatchesByPersonId = {};
  (treeParserResult.matches || []).forEach((match) => {
    const personId = String(match.data_id);
    if (!treeMatchesByPersonId[personId]) treeMatchesByPersonId[personId] = [];
    treeMatchesByPersonId[personId].push(match);
  });

  normalizedPersonIds.forEach((personId) => {
    const person = people[personId];
    if (!person) return;
    person.sourceSearchCache = person.sourceSearchCache || {};
    if (!treePersonIds.includes(personId)) {
      delete person.sourceSearchCache[USER_TREES_SOURCE_KEY];
      person.hasMatch = calculatePersonHasMatch(person);
      return;
    }

    person.sourceSearchCache[USER_TREES_SOURCE_KEY] = sourceCacheEntry({
      sourceKey: USER_TREES_SOURCE_KEY,
      sourceLabel: USER_TREES_SOURCE.label,
      matches: treeMatchesByPersonId[personId] || [],
      errors: (treeParserResult.errors || []).filter((entry) => String(entry?.person_id) === personId),
      searchCriteria
    });
    person.sourceSearchCache[USER_TREES_SOURCE_KEY].autoSearchSignature = buildAutoSearchSignature(person, USER_TREES_SOURCE_KEY);
    person.hasMatch = calculatePersonHasMatch(person);
  });

  for (const source of SUPPORTED_SMART_SOURCES) {
    const peopleToSearch = [];
    normalizedPersonIds.forEach((personId) => {
      const person = people[personId];
      if (!person) return;
      person.sourceSearchCache = person.sourceSearchCache || {};
      if (!shouldRunSourceForPerson(person, source.key)) {
        delete person.sourceSearchCache[source.key];
        person.hasMatch = calculatePersonHasMatch(person);
        return;
      }

      const sourceCache = person.sourceSearchCache[source.key];
      const expectedSignature = buildAutoSearchSignature(person, source.key);
      const hasMatchingCriteria = sourceCache
        && typeof sourceCache === 'object'
        && areSearchCriteriaEqual(sourceCache.searchCriteria, searchCriteria);
      const hasCurrentSignature = sourceCache?.autoSearchSignature === expectedSignature;
      const hasCache = hasMatchingCriteria && hasCurrentSignature && Array.isArray(sourceCache.matches);
      if (!hasCache) {
        peopleToSearch.push(personId);
      } else {
        person.hasMatch = calculatePersonHasMatch(person);
      }
    });

    let parserResult = buildEmptySourceResult({
      sourceKey: source.key,
      sourceLabel: source.label,
      personIds: peopleToSearch
    });
    if (peopleToSearch.length > 0) {
      parserResult = await source.parser({
        people,
        personIds: peopleToSearch,
        searchCriteria
      });
    }

    const matchesByPersonId = {};
    (parserResult.matches || []).forEach((match) => {
      const personId = String(match.data_id);
      if (!matchesByPersonId[personId]) matchesByPersonId[personId] = [];
      matchesByPersonId[personId].push(match);
    });

    const errorsByPersonId = {};
    (parserResult.errors || []).forEach((entry) => {
      const personId = entry?.person_id ? String(entry.person_id) : null;
      if (!personId) return;
      if (!errorsByPersonId[personId]) errorsByPersonId[personId] = [];
      errorsByPersonId[personId].push(entry);
    });

    peopleToSearch.forEach((personId) => {
      const person = people[personId];
      if (!person) return;
      const personMatches = matchesByPersonId[personId] || [];
      const personErrors = errorsByPersonId[personId] || [];
      person.sourceSearchCache = person.sourceSearchCache || {};
      person.sourceSearchCache[source.key] = sourceCacheEntry({
        sourceKey: source.key,
        sourceLabel: source.label,
        matches: personMatches,
        errors: personErrors,
        searchCriteria
      });
      person.sourceSearchCache[source.key].autoSearchSignature = buildAutoSearchSignature(person, source.key);
      person.hasMatch = calculatePersonHasMatch(person);
    });
  }

  return {
    people,
    processedPersonIds: normalizedPersonIds
  };
};

const isReadyForSmartSearch = (person, searchCriteria = DEFAULT_SMART_SEARCH_CRITERIA) => {
  const requiresFullName = searchCriteria.fullName !== false;
  const requiresBirthDate = searchCriteria.birthDate !== false;
  const requiresBirthPlace = searchCriteria.birthPlace !== false;

  if (!requiresFullName && !requiresBirthDate && !requiresBirthPlace) {
    return false;
  }

  return Boolean(
    (!requiresFullName || (hasValue(person?.lastName) && hasValue(person?.name) && hasValue(person?.middleName))) &&
    (!requiresBirthDate || hasValue(person?.birthDate)) &&
    (!requiresBirthPlace || hasValue(person?.birthPlace))
  );
};

// Source search endpoint
app.post('/api/smart-matching', async (req, res) => {
  try {
    const state = readDatabaseState();
    const data = { people: state.people };
    const personIds = normalizePersonIds(req.body?.personIds, data.people);
    const sources = req.body?.sources || {};
    const searchCriteria = normalizeSearchCriteria(req.body?.searchCriteria || DEFAULT_SMART_SEARCH_CRITERIA);

    const enabledSourceKeys = new Set([
      ...(sources[USER_TREES_SOURCE_KEY] !== false ? [USER_TREES_SOURCE_KEY] : []),
      ...SUPPORTED_SMART_SOURCES
        .filter(source => sources[source.key] !== false)
        .map(source => source.key)
    ]);

    const applyManualEligibility = (person, sourceKey) => {
      const requirement = AUTO_SOURCE_REQUIREMENTS[sourceKey];
      const baseEligible = requirement ? requirement.hasRequiredFields(person) : true;
      const criteriaEligible = isReadyForSmartSearch(person, searchCriteria);
      return baseEligible && criteriaEligible;
    };

    const sourceSpecificPersonIds = {};
    enabledSourceKeys.forEach((sourceKey) => {
      sourceSpecificPersonIds[sourceKey] = personIds.filter((personId) => {
        const person = data.people[personId];
        return person && applyManualEligibility(person, sourceKey);
      });
    });

    const idsToProcess = new Set();
    Object.values(sourceSpecificPersonIds).forEach((ids) => ids.forEach((id) => idsToProcess.add(id)));

    await runSmartMatchingForPeople({
      people: data.people,
      personIds: Array.from(idsToProcess),
      searchCriteria
    });

    personIds.forEach((personId) => {
      const person = data.people[personId];
      if (!person || !person.sourceSearchCache) return;
      Object.keys(person.sourceSearchCache).forEach((sourceKey) => {
        if (!enabledSourceKeys.has(sourceKey)) {
          delete person.sourceSearchCache[sourceKey];
        }
      });
      person.hasMatch = calculatePersonHasMatch(person);
    });

    writeCurrentPeople(data.people);

    const allTreeMatches = sourceSpecificPersonIds[USER_TREES_SOURCE_KEY]
      ? sourceSpecificPersonIds[USER_TREES_SOURCE_KEY].flatMap((personId) => {
        const person = data.people[personId];
        if (!person) return [];
        const cacheEntry = person.sourceSearchCache?.[USER_TREES_SOURCE_KEY];
        return cacheEntry?.matches || [];
      })
      : [];
    const allSourceMatches = personIds.flatMap((personId) => {
      const person = data.people[personId];
      if (!person) return [];
      return SUPPORTED_SMART_SOURCES
        .filter((source) => enabledSourceKeys.has(source.key))
        .flatMap((source) => {
          const cacheEntry = person.sourceSearchCache?.[source.key];
          return cacheEntry?.matches || [];
        });
    });
    const matchedDataIds = [...new Set(
      [...allTreeMatches, ...allSourceMatches].map(match => String(match.data_id))
    )];

    res.json({
      treeMatches: allTreeMatches,
      archiveMatches: allSourceMatches,
      matchedDataIds,
      processedPersonIds: personIds,
      sources: [
        ...(enabledSourceKeys.has(USER_TREES_SOURCE.key) ? [{ key: USER_TREES_SOURCE.key, label: USER_TREES_SOURCE.label }] : []),
        ...SUPPORTED_SMART_SOURCES
          .filter((source) => enabledSourceKeys.has(source.key))
          .map(source => ({ key: source.key, label: source.label }))
      ],
      searchCriteria
    });
  } catch (error) {
    console.error('Source search error:', error);
    res.status(500).json({ error: 'Source search failed', details: error.message });
  }
});

// Get cached source matches for a specific person
app.get('/api/people/:id/matches', async (req, res) => {
  try {
    const state = readDatabaseState();
    const personId = req.params.id;
    
    if (!state.people[personId]) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const sourceCache = state.people[personId].sourceSearchCache || {};
    const personTreeMatches = Array.isArray(sourceCache[USER_TREES_SOURCE_KEY]?.matches)
      ? sourceCache[USER_TREES_SOURCE_KEY].matches
      : [];
    const personArchiveMatches = SUPPORTED_SMART_SOURCES.flatMap((source) => {
      const sourceEntry = sourceCache[source.key];
      return Array.isArray(sourceEntry?.matches) ? sourceEntry.matches : [];
    });
    
    res.json({ 
      treeMatches: personTreeMatches,
      archiveMatches: personArchiveMatches
    });
  } catch (error) {
    console.error('Get matches error:', error);
    res.status(500).json({ error: 'Failed to get matches', details: error.message });
  }
});

// Confirm match and add fragment to tree
app.post('/api/people/:id/confirm-match', (req, res) => {
  const state = readDatabaseState();
  const people = { ...state.people };
  const personId = req.params.id;
  const person = people[personId];
  const { match } = req.body; // Contains the full match object including people fragment
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  if (!match || !match.people) {
    return res.status(400).json({ error: 'Invalid match data' });
  }
  
  const fragment = match.people;
  const matchedDbId = match.database_id;
  
  // Create ID mapping from old database IDs to new IDs
  const idMapping = {};
  
  // First pass: generate new IDs for all people in fragment except the matched person
  Object.keys(fragment).forEach(oldId => {
    if (oldId === matchedDbId) {
      // The matched person maps to the existing person in our tree
      idMapping[oldId] = personId;
    } else {
      // Generate new ID for relatives
      idMapping[oldId] = generateId() + Math.random().toString(36).substr(2, 4);
    }
  });
  
  // Second pass: add people with remapped IDs
  Object.entries(fragment).forEach(([oldId, fragmentPerson]) => {
    const newId = idMapping[oldId];
    
    // Skip the matched person (they already exist)
    if (oldId === matchedDbId) {
      // But update their parent references if they don't have them
      if (fragmentPerson.fatherId && !person.fatherId) {
        person.fatherId = idMapping[fragmentPerson.fatherId] || null;
      }
      if (fragmentPerson.motherId && !person.motherId) {
        person.motherId = idMapping[fragmentPerson.motherId] || null;
      }
      // Mark match as confirmed
      person.hasMatch = false;
      people[personId] = person;
      return;
    }
    
    // Create new person with remapped IDs
    const newPerson = {
      id: newId,
      name: fragmentPerson.name || '',
      lastName: fragmentPerson.lastName || '',
      middleName: fragmentPerson.middleName || '',
      gender: fragmentPerson.gender || 'male',
      fatherId: fragmentPerson.fatherId ? (idMapping[fragmentPerson.fatherId] || null) : null,
      motherId: fragmentPerson.motherId ? (idMapping[fragmentPerson.motherId] || null) : null,
      partnerId: fragmentPerson.partnerId ? (idMapping[fragmentPerson.partnerId] || null) : null,
      children: (fragmentPerson.children || [])
        .map(childId => idMapping[childId])
        .filter(Boolean),
      isAlive: fragmentPerson.isAlive !== undefined ? fragmentPerson.isAlive : true,
      birthDate: fragmentPerson.birthDate || '',
      birthPlace: fragmentPerson.birthPlace || '',
      information: fragmentPerson.information || '',
      hasMatch: false
    };
    
    people[newId] = newPerson;
  });

  if (writeCurrentPeople(people)) {
    res.json({ success: true, message: 'Match confirmed and relatives added', people });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Confirm archive match (add information to person's card)
app.post('/api/people/:id/confirm-archive-match', (req, res) => {
  const state = readDatabaseState();
  const people = { ...state.people };
  const personId = req.params.id;
  const person = people[personId];
  const { match } = req.body; // Contains the archive match with person data
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  if (!match || !match.person) {
    return res.status(400).json({ error: 'Invalid archive match data' });
  }
  
  // Update person's information with archive data
  person.information = match.person.information || '';
  
  // Optionally update other fields if they're empty
  if (!person.birthDate && match.person.birthDate) {
    person.birthDate = match.person.birthDate;
  }
  if (!person.birthPlace && match.person.birthPlace) {
    person.birthPlace = match.person.birthPlace;
  }
  
  // Reset hasMatch flag (check if there are still other matches)
  person.hasMatch = false;
  
  people[personId] = person;

  if (writeCurrentPeople(people)) {
    res.json({ success: true, message: 'Archive information added', person: person });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

app.post('/api/database/upload', async (req, res) => {
  const payload = req.body;
  let entries = [];

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload?.data && Array.isArray(payload.data)) {
    entries = payload.data;
  } else {
    return res.status(400).json({ error: 'Payload must be a JSON array in example.json format' });
  }

  if (!writeDatabaseEntries(entries)) {
    return res.status(500).json({ error: 'Failed to save uploaded database' });
  }

  const state = readDatabaseState();
  const people = { ...state.people };
  const personIds = Object.keys(people);
  if (personIds.length > 0) {
    await runSmartMatchingForPeople({
      people,
      personIds,
      searchCriteria: AUTO_SMART_SEARCH_CRITERIA
    });
    if (!writeCurrentPeople(people)) {
      return res.status(500).json({ error: 'Failed to save auto-search results' });
    }
  }
  const refreshedState = readDatabaseState();
  res.json({
    success: true,
    people: refreshedState.people,
    records: entries.length
  });
});

app.get('/api/database/export', (req, res) => {
  const entries = parseDatabaseFile();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="database.json"');
  res.send(JSON.stringify(entries, null, 2));
});

app.listen(PORT, () => {
  console.log(`🌳 Family Tree Server running on http://localhost:${PORT}`);
});