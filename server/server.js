const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Path to data files
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const DATABASE_FILE = path.join(__dirname, '..', 'database.json');
const SMART_MATCHING_SCRIPT = path.join(__dirname, '..', 'smart_matching.py');
const PAMYAT_NARODA_SCRIPT = path.join(__dirname, '..', 'pamyat_naroda.py');

// Helper functions
const readData = () => {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading data file:', error);
    return { people: {} };
  }
};

const writeData = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing data file:', error);
    return false;
  }
};

const generateId = () => {
  return Date.now().toString();
};

const readDatabase = () => {
  try {
    const data = fs.readFileSync(DATABASE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database file:', error);
    return { tree_id: {} };
  }
};

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
  const data = readData();
  res.json(data.people);
});

// Get single person by ID
app.get('/api/people/:id', (req, res) => {
  const data = readData();
  const person = data.people[req.params.id];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  res.json(person);
});

// Create new person
app.post('/api/people', (req, res) => {
  const data = readData();
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
  
  data.people[newPerson.id] = newPerson;
  
  if (writeData(data)) {
    res.status(201).json(newPerson);
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Update person
app.put('/api/people/:id', (req, res) => {
  const data = readData();
  const person = data.people[req.params.id];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  // Update person fields
  const updatedPerson = {
    ...person,
    ...req.body,
    id: req.params.id // Ensure ID doesn't change
  };
  
  data.people[req.params.id] = updatedPerson;
  
  if (writeData(data)) {
    res.json(updatedPerson);
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Delete person
app.delete('/api/people/:id', (req, res) => {
  const data = readData();
  const personId = req.params.id;
  const person = data.people[personId];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  // Remove references to this person from other people
  Object.values(data.people).forEach((p) => {
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
  delete data.people[personId];
  
  if (writeData(data)) {
    res.json({ success: true, message: 'Person deleted successfully' });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Add relative to a person
app.post('/api/people/:id/relative', (req, res) => {
  const data = readData();
  const personId = req.params.id;
  const person = data.people[personId];
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
      if (person.motherId && data.people[person.motherId]) {
        newRelative.partnerId = person.motherId;
        data.people[person.motherId].partnerId = newRelativeId;
      }
      break;
      
    case 'mother':
      newRelative.gender = 'female';
      if (!newRelative.children.includes(personId)) {
        newRelative.children.push(personId);
      }
      person.motherId = newRelativeId;
      // If father exists, link mother as partner
      if (person.fatherId && data.people[person.fatherId]) {
        newRelative.partnerId = person.fatherId;
        data.people[person.fatherId].partnerId = newRelativeId;
      }
      break;
      
    case 'son':
      newRelative.gender = 'male';
      if (person.gender === 'male') {
        newRelative.fatherId = personId;
        if (person.partnerId) {
          newRelative.motherId = person.partnerId;
          if (data.people[person.partnerId]) {
            data.people[person.partnerId].children.push(newRelativeId);
          }
        }
      } else {
        newRelative.motherId = personId;
        if (person.partnerId) {
          newRelative.fatherId = person.partnerId;
          if (data.people[person.partnerId]) {
            data.people[person.partnerId].children.push(newRelativeId);
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
          if (data.people[person.partnerId]) {
            data.people[person.partnerId].children.push(newRelativeId);
          }
        }
      } else {
        newRelative.motherId = personId;
        if (person.partnerId) {
          newRelative.fatherId = person.partnerId;
          if (data.people[person.partnerId]) {
            data.people[person.partnerId].children.push(newRelativeId);
          }
        }
      }
      person.children.push(newRelativeId);
      break;
      
    default:
      return res.status(400).json({ error: 'Invalid relation type' });
  }
  
  data.people[newRelativeId] = newRelative;
  data.people[personId] = person;
  
  if (writeData(data)) {
    res.status(201).json({ person, newRelative });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Get person with full family info (for card display)
app.get('/api/people/:id/family', (req, res) => {
  const data = readData();
  const person = data.people[req.params.id];
  
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }
  
  const getFullName = (p) => {
    if (!p) return null;
    return `${p.lastName || ''} ${p.name || ''} ${p.middleName || ''}`.trim();
  };
  
  const getPersonInfo = (id) => {
    const p = data.people[id];
    if (!p) return null;
    return {
      id: p.id,
      fullName: getFullName(p),
      gender: p.gender
    };
  };
  
  // Get siblings (people with same parents)
  const siblings = [];
  Object.values(data.people).forEach(p => {
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
    const data = readData();
    const database = readDatabase();
    
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
    
    writeData(data);
    
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
    const data = readData();
    const database = readDatabase();
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
  const data = readData();
  const personId = req.params.id;
  const person = data.people[personId];
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
      data.people[personId] = person;
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
    
    data.people[newId] = newPerson;
  });
  
  if (writeData(data)) {
    res.json({ success: true, message: 'Match confirmed and relatives added', people: data.people });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Confirm archive match (add information to person's card)
app.post('/api/people/:id/confirm-archive-match', (req, res) => {
  const data = readData();
  const personId = req.params.id;
  const person = data.people[personId];
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
  
  data.people[personId] = person;
  
  if (writeData(data)) {
    res.json({ success: true, message: 'Archive information added', person: person });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

app.listen(PORT, () => {
  console.log(`🌳 Family Tree Server running on http://localhost:${PORT}`);
});