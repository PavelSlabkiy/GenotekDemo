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
const SMART_MATCHING_SCRIPT = path.join(__dirname, '..', 'smart_matching.py');
const PAMYAT_NARODA_SCRIPT = path.join(__dirname, '..', 'pamyat_naroda.py');

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

const relationshipTemplate = (partnerId) => ({
  with: toOidObject(partnerId),
  type: 'official',
  finished: null,
  from: [{ day: null, month: null, year: null }],
  to: [{ day: null, month: null, year: null }]
});

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
      information: entry.information || ''
    };
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
      hasMatch: Boolean(person.hasMatch)
    };

    if (person.information) {
      entry.information = person.information;
    } else {
      delete entry.information;
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

// Run smart-matching Python script
const runSmartMatching = (dataJson, databaseJson) => {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', [SMART_MATCHING_SCRIPT]);
    
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
        console.error('Smart matching stderr:', stderr);
        reject(new Error(`Smart matching failed with code ${code}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        reject(new Error('Failed to parse smart matching output'));
      }
    });
    
    // Send input to Python script
    const input = JSON.stringify({
      data: JSON.stringify(dataJson),
      db: JSON.stringify(databaseJson)
    });
    python.stdin.write(input);
    python.stdin.end();
  });
};

// Run pamyat-naroda Python script (with longer timeout for archive search)
const runPamyatNaroda = (dataJson) => {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', [PAMYAT_NARODA_SCRIPT], {
      timeout: 60000 // 60 second timeout for archive search
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
        console.error('Pamyat Naroda stderr:', stderr);
        // Return empty result instead of rejecting (archive might be unavailable)
        resolve({ matches: [], matchedDataIds: [] });
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        console.error('Failed to parse pamyat naroda output:', stdout);
        resolve({ matches: [], matchedDataIds: [] });
      }
    });
    
    python.on('error', (err) => {
      console.error('Pamyat Naroda error:', err);
      resolve({ matches: [], matchedDataIds: [] });
    });
    
    // Send input to Python script
    const input = JSON.stringify({
      data: JSON.stringify(dataJson)
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
app.post('/api/people', (req, res) => {
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
    hasMatch: req.body.hasMatch || false
  };

  people[newPerson.id] = newPerson;

  if (writeCurrentPeople(people)) {
    res.status(201).json(newPerson);
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Update person
app.put('/api/people/:id', (req, res) => {
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
app.post('/api/people/:id/relative', (req, res) => {
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
    hasMatch: false
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

// Combined matching endpoint (smart-matching + pamyat-naroda)
app.post('/api/smart-matching', async (req, res) => {
  try {
    const state = readDatabaseState();
    const data = { people: state.people };
    const database = state.smartMatchingDatabase;
    
    // Run both searches in parallel
    const [smartResult, archiveResult] = await Promise.all([
      runSmartMatching(data, database),
      runPamyatNaroda(data)
    ]);
    
    // Filter smart matches to only include those with actual relatives to add
    const validTreeMatches = (smartResult.matches || []).filter(match => {
      if (!match.people) return false;
      const fragmentPeopleCount = Object.keys(match.people).length;
      return fragmentPeopleCount > 1;
    });
    
    // Archive matches are already filtered (only people without information)
    const validArchiveMatches = archiveResult.matches || [];
    
    // Combine matched IDs from both sources
    const treeMatchedIds = [...new Set(validTreeMatches.map(m => m.data_id))];
    const archiveMatchedIds = archiveResult.matchedDataIds || [];
    const allMatchedIds = [...new Set([...treeMatchedIds, ...archiveMatchedIds])];
    
    // Reset all hasMatch flags, then set true for people with any valid matches
    Object.keys(data.people).forEach(id => {
      data.people[id].hasMatch = allMatchedIds.includes(id);
    });

    writeCurrentPeople(data.people);
    
    res.json({
      treeMatches: validTreeMatches,
      archiveMatches: validArchiveMatches,
      matchedDataIds: allMatchedIds
    });
  } catch (error) {
    console.error('Smart matching error:', error);
    res.status(500).json({ error: 'Smart matching failed', details: error.message });
  }
});

// Get matches for a specific person (both tree and archive)
app.get('/api/people/:id/matches', async (req, res) => {
  try {
    const state = readDatabaseState();
    const data = { people: state.people };
    const database = state.smartMatchingDatabase;
    const personId = req.params.id;
    
    if (!data.people[personId]) {
      return res.status(404).json({ error: 'Person not found' });
    }
    
    // Run both searches in parallel
    const [smartResult, archiveResult] = await Promise.all([
      runSmartMatching(data, database),
      runPamyatNaroda(data)
    ]);
    
    // Filter tree matches for this person with relatives to add
    const personTreeMatches = (smartResult.matches || []).filter(m => {
      if (m.data_id !== personId) return false;
      if (!m.people) return false;
      return Object.keys(m.people).length > 1;
    });
    
    // Filter archive matches for this person
    const personArchiveMatches = (archiveResult.matches || []).filter(m => 
      m.data_id === personId
    );
    
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

app.post('/api/database/upload', (req, res) => {
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
  res.json({
    success: true,
    people: state.people,
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