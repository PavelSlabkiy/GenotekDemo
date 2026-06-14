import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  User, 
  ArrowLeft,
  Calendar, 
  MapPin, 
  X, 
  Edit2, 
  UserPlus, 
  Trash2,
  Heart,
  Baby,
  ChevronDown,
  Check,
  AlertTriangle,
  Home,
  HeartPulse,
  ThumbsUp,
  FileText,
  ClipboardList,
  Globe2,
  GitBranch,
  Briefcase,
  TreePine,
  ChevronRight,
  Users,
  Plus,
  Minus,
  Search,
  Download,
  Upload,
  Navigation,
  MoreHorizontal,
  Lock,
  Send,
  CreditCard,
  Bell
} from 'lucide-react';

const API_URL = '/api';
const SMART_SEARCH_STUDIED_STORAGE_KEY = 'genotek-smart-search-studied-entry-keys-v2';
const SMART_SEARCH_SUPPORTED_SOURCE_KEYS = ['userTrees', 'pamyatNaroda', 'openList', 'gwar'];
const SMART_SEARCH_SOURCE_LABELS = {
  userTrees: 'Деревья других пользователей',
  pamyatNaroda: 'Память народа',
  openList: 'Открытый список',
  gwar: 'Герои великой войны',
  warHeroes: 'Герои великой войны'
};
const SMART_SEARCH_ARCHIVE_SOURCE_KEYS = ['pamyatNaroda', 'openList', 'gwar', 'warHeroes'];
const DEFAULT_SMART_SEARCH_CRITERIA = {
  fullName: true,
  birthDate: true,
  birthPlace: true
};
const DEFAULT_ADMIN_SOURCE_PREFERENCES = {
  userTrees: true,
  pamyatNaroda: true,
  openList: true,
  gwar: true
};
const DEFAULT_ADMIN_SCORE_THRESHOLDS = {
  treeMatches: 90,
  archiveMatches: 80
};

// Layout constants
const CARD_WIDTH = 140;
const CARD_HEIGHT = 120;
const HORIZONTAL_GAP = 44;
const VERTICAL_GAP = 110;
const COUPLE_GAP = 80;
const PADDING = 60;
const BRANCH_GAP = 86;

const PARTIAL_DATE_ERROR = 'Введите дату в формате гггг, мм.гггг или дд.мм.гггг';

const normalizePartialDate = (value) => {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';

  let match = text.match(/^(\d{4})$/) || text.match(/^(?:__|00)\.(?:__|00)\.(\d{4})$/);
  if (match) return String(Number(match[1])).padStart(4, '0');

  match = text.match(/^(\d{4})-(\d{1,2})$/);
  if (match) {
    const [, year, month] = match;
    const monthNumber = Number(month);
    return monthNumber >= 1 && monthNumber <= 12
      ? `${String(Number(year)).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`
      : '';
  }

  match = text.match(/^(\d{1,2})\.(\d{4})$/) || text.match(/^(?:__|00)\.(\d{1,2})\.(\d{4})$/);
  if (match) {
    const [, month, year] = match;
    const monthNumber = Number(month);
    return monthNumber >= 1 && monthNumber <= 12
      ? `${String(Number(year)).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`
      : '';
  }

  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let year;
  let month;
  let day;
  if (match) {
    [, year, month, day] = match;
  } else {
    match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!match) return '';
    [, day, month, year] = match;
  }

  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const candidate = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (
    candidate.getUTCFullYear() !== yearNumber
    || candidate.getUTCMonth() !== monthNumber - 1
    || candidate.getUTCDate() !== dayNumber
  ) {
    return '';
  }
  return `${String(yearNumber).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
};

const formatDateForInput = (dateStr) => {
  const normalized = normalizePartialDate(dateStr);
  if (!normalized) return String(dateStr || '').trim();
  const [year, month, day] = normalized.split('-');
  if (!month) return year;
  if (!day) return `${month}.${year}`;
  return `${day}.${month}.${year}`;
};

const formatDate = (dateStr) => {
  if (!dateStr) return 'Не указана';
  return formatDateForInput(dateStr) || 'Не указана';
};

const extractBirthYear = (dateStr) => {
  const normalized = normalizePartialDate(dateStr);
  return normalized ? Number(normalized.slice(0, 4)) : null;
};

const PartialDateInput = ({ value, onChange }) => {
  const validate = (event) => {
    const raw = event.currentTarget.value.trim();
    event.currentTarget.setCustomValidity(raw && !normalizePartialDate(raw) ? PARTIAL_DATE_ERROR : '');
  };

  return (
    <input
      type="text"
      name="birthDate"
      inputMode="numeric"
      className="form-input"
      value={value}
      onChange={(event) => {
        event.currentTarget.setCustomValidity('');
        onChange(event.target.value);
      }}
      onBlur={validate}
      onInvalid={validate}
      placeholder="гггг, мм.гггг или дд.мм.гггг"
      title={PARTIAL_DATE_ERROR}
    />
  );
};

// Get full name
const getFullName = (person) => {
  if (!person) return '';
  return `${person.lastName || ''} ${person.name || ''} ${person.middleName || ''}`.trim();
};

const getPersonLabel = (person) => getFullName(person) || person?.id || 'Без имени';
const getInitials = (person = {}) => {
  const lastInitial = String(person.lastName || '').trim().charAt(0);
  const firstInitial = String(person.name || '').trim().charAt(0);
  const fallback = String(person.middleName || '').trim().charAt(0);
  return `${lastInitial}${firstInitial || fallback}`.toUpperCase() || '??';
};
const getGenderClass = (person = {}) => (
  person.gender === 'male'
    ? 'male'
    : person.gender === 'female'
      ? 'female'
      : ''
);
const getMatchScoreClass = (score) => {
  if (score < 50) return 'low';
  if (score < 80) return 'medium';
  return 'high';
};
const getOwnerInitials = (owner = '') => {
  const ownerName = String(owner).split('@')[0].replace(/[._-]+/g, ' ').trim();
  const parts = ownerName.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part.charAt(0)).join('').toUpperCase() || '??';
};
const getTreeMatchTitle = (count) => (
  `Найдено совпадение по ${count} ${count === 1 ? 'родственнику' : 'родственникам'}`
);
const getAddedRelativesTitle = (count) => {
  const normalizedCount = Number(count) || 0;
  const mod10 = normalizedCount % 10;
  const mod100 = normalizedCount % 100;
  const noun = mod10 === 1 && mod100 !== 11
    ? 'родственник'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? 'родственника'
      : 'родственников';
  const verb = normalizedCount === 1 ? 'Добавлен' : 'Добавлено';
  return `${verb} ${normalizedCount} ${noun}`;
};
const getTreeEntryTitle = (entry = {}) => (
  entry.isMerged
    ? getAddedRelativesTitle(entry.addedCount)
    : getTreeMatchTitle(entry.pairs?.length || 0)
);

const FourPointStar = ({ size = 16, className = '' }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M12 2L14.6 9.4L22 12L14.6 14.6L12 22L9.4 14.6L2 12L9.4 9.4L12 2Z"
      fill="currentColor"
    />
  </svg>
);

const AdminScoreThresholdFields = ({ thresholds, onChange }) => (
  <div className="admin-thresholds">
    <h4>Пороги совпадений</h4>
    <label className="admin-threshold-item">
      <span>Между деревьями</span>
      <span className="admin-threshold-control">
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          value={thresholds.treeMatches}
          onChange={(event) => onChange('treeMatches', event.target.value)}
        />
        <span>%</span>
      </span>
    </label>
    <label className="admin-threshold-item">
      <span>Для архивов</span>
      <span className="admin-threshold-control">
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          value={thresholds.archiveMatches}
          onChange={(event) => onChange('archiveMatches', event.target.value)}
        />
        <span>%</span>
      </span>
    </label>
  </div>
);

const normalizeSearchValue = (value = '') => value.toLowerCase().replace(/\s+/g, ' ').trim();

const isReadyForSmartSearch = (person, searchCriteria = DEFAULT_SMART_SEARCH_CRITERIA) => {
  const requiresFullName = searchCriteria.fullName !== false;
  const requiresBirthDate = searchCriteria.birthDate !== false;
  const requiresBirthPlace = searchCriteria.birthPlace !== false;

  if (!requiresFullName && !requiresBirthDate && !requiresBirthPlace) {
    return false;
  }

  return Boolean(
    (!requiresFullName || (person?.lastName && person?.name && person?.middleName)) &&
    (!requiresBirthDate || person?.birthDate) &&
    (!requiresBirthPlace || person?.birthPlace)
  );
};

const getSourceMatches = (person, sourceKey) => {
  if (!person?.sourceSearchCache || !person.sourceSearchCache[sourceKey]) {
    return [];
  }
  const sourceEntry = person.sourceSearchCache[sourceKey];
  return Array.isArray(sourceEntry.matches) ? sourceEntry.matches : [];
};

const getSourceRecords = (person, sourceKey) => {
  const records = [];
  getSourceMatches(person, sourceKey).forEach((match) => {
    const sourceLabel = match.sourceLabel || SMART_SEARCH_SOURCE_LABELS[sourceKey] || 'Источник';
    if (match.people && match.database_id) {
      const treePerson = match.people[match.database_id];
      if (treePerson) {
        records.push({
          ...treePerson,
          sourceLabel,
          sourceKey,
          score: match.score,
          matchedPersonId: String(match.data_id || person.id),
          tree_id: match.tree_id,
          tree_owner: match.tree_owner,
          database_id: match.database_id,
          treeMergeOperationId: match.treeMergeOperationId || '',
          treeMergeStatus: match.treeMergeStatus || '',
          treeMergeAddedCount: Number(match.treeMergeAddedCount) || 0
        });
      }
      return;
    }
    if (Array.isArray(match.records) && match.records.length > 0) {
      match.records.forEach((record) => {
        records.push({
          ...record,
          sourceLabel: record.sourceLabel || sourceLabel,
          sourceKey
        });
      });
      return;
    }
    if (match.person) {
      records.push({
        ...match.person,
        sourceLabel,
        sourceKey,
        score: match.score
      });
    }
  });
  return records;
};

const isUserTreeRecord = (record = {}) => record.sourceKey === 'userTrees' || Boolean(record.tree_id);
const isArchiveRecord = (record = {}) => SMART_SEARCH_ARCHIVE_SOURCE_KEYS.includes(record.sourceKey);

const getDocumentKey = (document = {}) => {
  const normalizedTitle = document.title || getPersonLabel(document);
  const keyParts = [
    document.id,
    document.sourceKey,
    document.sourceLabel,
    document.tree_id,
    document.database_id,
    document.tree_owner,
    document.url,
    normalizedTitle,
    document.birthDate,
    document.birthPlace,
    document.information
  ];
  return keyParts
    .filter((part) => part !== undefined && part !== null && String(part).trim())
    .join('|');
};

const getStableStringHash = (value) => {
  let hash = 2166136261;
  String(value).split('').forEach((character) => {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  });
  return (hash >>> 0).toString(36);
};

const getSmartSearchEntryStudyKey = (entry = {}) => {
  const recordKeys = entry.sourceType === 'tree'
    ? (entry.pairs || []).map(({ person, record }) => [
      String(person?.id || ''),
      getDocumentKey(record),
      record?.treeMergeStatus || '',
      record?.treeMergeOperationId || '',
      Number(record?.treeMergeAddedCount) || 0
    ].join('|'))
    : (entry.sourceRecords || []).map((record) => getDocumentKey(record));
  return `${entry.id || 'entry'}:${getStableStringHash(recordKeys.sort().join('||'))}`;
};

const normalizeDocumentRecord = (record = {}) => ({
  id: record.id || '',
  sourceKey: record.sourceKey || '',
  sourceLabel: record.sourceLabel || 'Источник',
  title: record.title || getPersonLabel(record),
  url: record.url || '',
  birthDate: record.birthDate || '',
  birthPlace: record.birthPlace || '',
  information: record.information || '',
  score: typeof record.score === 'number' ? record.score : null,
  tree_id: record.tree_id || '',
  tree_owner: record.tree_owner || '',
  database_id: record.database_id || ''
});

const getDocumentSourceClass = (sourceLabel = '') => {
  const normalized = String(sourceLabel).toLowerCase();
  if (normalized.includes('память народа')) return 'source-pamyat';
  if (normalized.includes('открытый список')) return 'source-openlist';
  if (normalized.includes('герои великой войны')) return 'source-gwar';
  return '';
};

const pickFocalPersonId = (people, selectedPersonId) => {
  if (selectedPersonId && people[selectedPersonId]) return selectedPersonId;

  const peopleArray = Object.values(people);
  if (peopleArray.length === 0) return null;

  const withParents = peopleArray.find(p => p.fatherId || p.motherId);
  if (withParents) return withParents.id;
  return peopleArray[0].id;
};

const getSiblings = (people, personId) => {
  const person = people[personId];
  if (!person) return [];
  return Object.values(people).filter((candidate) => {
    if (candidate.id === personId) return false;
    const sameFather = person.fatherId && candidate.fatherId === person.fatherId;
    const sameMother = person.motherId && candidate.motherId === person.motherId;
    return sameFather || sameMother;
  });
};

const buildTreeView = (allPeople, focalPersonId, expandedSiblingGroups) => {
  if (!focalPersonId || !allPeople[focalPersonId]) {
    return { visiblePeople: allPeople, collapsedGroups: [] };
  }

  const lineageIds = new Set();
  const visitedAncestors = new Set();
  const visitedDescendants = new Set();

  const addAncestors = (id) => {
    if (!id || visitedAncestors.has(id) || !allPeople[id]) return;
    visitedAncestors.add(id);
    lineageIds.add(id);
    const person = allPeople[id];
    addAncestors(person.fatherId);
    addAncestors(person.motherId);
    if (person.partnerId && allPeople[person.partnerId]) {
      lineageIds.add(person.partnerId);
    }
  };

  const addDescendants = (id) => {
    if (!id || visitedDescendants.has(id) || !allPeople[id]) return;
    visitedDescendants.add(id);
    lineageIds.add(id);
    const person = allPeople[id];
    if (person.partnerId && allPeople[person.partnerId]) {
      lineageIds.add(person.partnerId);
    }
    (person.children || []).forEach((childId) => addDescendants(childId));
  };

  const addSiblingBranch = (id, visited = new Set()) => {
    if (!id || visited.has(id) || !allPeople[id]) return;
    visited.add(id);
    lineageIds.add(id);
    const person = allPeople[id];
    if (person.partnerId && allPeople[person.partnerId]) {
      lineageIds.add(person.partnerId);
    }
    (person.children || []).forEach((childId) => addSiblingBranch(childId, visited));
  };

  addAncestors(focalPersonId);
  addDescendants(focalPersonId);

  const collapsedGroups = [];
  Array.from(lineageIds).forEach((personId) => {
    const siblings = getSiblings(allPeople, personId);
    if (siblings.length === 0) return;

    const groupKey = `siblings:${personId}`;
    if (expandedSiblingGroups[groupKey]) {
      siblings.forEach((sibling) => addSiblingBranch(sibling.id));
    } else {
      collapsedGroups.push({
        key: groupKey,
        anchorId: personId,
        count: siblings.length
      });
    }
  });

  const visiblePeople = {};
  lineageIds.forEach((id) => {
    const person = allPeople[id];
    if (!person) return;
    const filteredChildren = (person.children || []).filter((childId) => lineageIds.has(childId));
    visiblePeople[id] = {
      ...person,
      children: filteredChildren,
      fatherId: person.fatherId && lineageIds.has(person.fatherId) ? person.fatherId : null,
      motherId: person.motherId && lineageIds.has(person.motherId) ? person.motherId : null,
      partnerId: person.partnerId && lineageIds.has(person.partnerId) ? person.partnerId : null
    };
  });

  return { visiblePeople, collapsedGroups };
};

// ============================================
// TREE LAYOUT ENGINE
// ============================================

class TreeLayoutEngine {
  constructor(people) {
    this.people = people;
    this.positions = new Map();
    this.generations = new Map();
    this.units = new Map();
    this.unitByPerson = new Map();
    this.unitGenerations = new Map();
    this.unitLayouts = new Map();
    this.childrenByUnit = new Map();
    this.parentsByUnit = new Map();
    this.familyEdges = [];
    this.unitSlotLayouts = new Map();
  }

  getBirthYear(person) {
    return extractBirthYear(person?.birthDate) ?? Infinity;
  }

  comparePersonIds(a, b) {
    const personA = this.people[a];
    const personB = this.people[b];
    const genderRank = (person) => {
      if (person?.gender === 'male') return 0;
      if (person?.gender === 'female') return 1;
      return 2;
    };

    const genderDelta = genderRank(personA) - genderRank(personB);
    if (genderDelta !== 0) return genderDelta;

    const yearDelta = this.getBirthYear(personA) - this.getBirthYear(personB);
    if (Number.isFinite(yearDelta) && yearDelta !== 0) return yearDelta;

    return getPersonLabel(personA).localeCompare(getPersonLabel(personB), 'ru');
  }

  compareUnitIds(a, b) {
    const firstA = this.units.get(a)?.[0];
    const firstB = this.units.get(b)?.[0];
    return this.comparePersonIds(firstA, firstB);
  }

  getParentUnitsForPerson(personId) {
    const childUnitId = this.unitByPerson.get(personId);
    const parentUnitIds = this.familyEdges
      .filter(edge => edge.childUnitId === childUnitId && edge.childPersonId === personId)
      .map(edge => edge.parentUnitId);

    return Array.from(new Set(parentUnitIds)).sort((a, b) => this.compareUnitIds(a, b));
  }

  getPersonAncestorWidth(personId, stack = new Set()) {
    const parentUnitIds = this.getParentUnitsForPerson(personId)
      .filter(parentUnitId => !stack.has(parentUnitId));

    if (parentUnitIds.length === 0) return CARD_WIDTH;

    const parentsWidth = parentUnitIds.reduce((sum, parentUnitId) => {
      return sum + this.getUnitWidth(parentUnitId, stack);
    }, 0);
    const parentsGap = Math.max(0, parentUnitIds.length - 1) * HORIZONTAL_GAP;

    return Math.max(CARD_WIDTH, parentsWidth + parentsGap);
  }

  getUnitSlotLayout(unitId, stack = new Set()) {
    if (this.unitSlotLayouts.has(unitId)) {
      return this.unitSlotLayouts.get(unitId);
    }

    if (stack.has(unitId)) {
      const personIds = this.units.get(unitId) || [];
      const fallbackWidth = personIds.length * CARD_WIDTH + Math.max(0, personIds.length - 1) * COUPLE_GAP;
      return {
        offsets: new Map(personIds.map((personId, index) => [
          personId,
          -fallbackWidth / 2 + CARD_WIDTH / 2 + index * (CARD_WIDTH + COUPLE_GAP)
        ])),
        reservedWidth: Math.max(CARD_WIDTH, fallbackWidth),
        cardWidth: Math.max(CARD_WIDTH, fallbackWidth)
      };
    }

    stack.add(unitId);
    const personIds = this.units.get(unitId) || [];
    const slots = personIds.map(personId => ({
      personId,
      width: this.getPersonAncestorWidth(personId, stack)
    }));
    const reservedWidth = Math.max(
      CARD_WIDTH,
      slots.reduce((sum, slot) => sum + slot.width, 0) + Math.max(0, slots.length - 1) * COUPLE_GAP
    );
    const offsets = new Map();
    let cursor = -reservedWidth / 2;

    slots.forEach((slot) => {
      offsets.set(slot.personId, cursor + slot.width / 2);
      cursor += slot.width + COUPLE_GAP;
    });

    const cardBounds = personIds.map(personId => {
      const offset = offsets.get(personId) || 0;
      return {
        left: offset - CARD_WIDTH / 2,
        right: offset + CARD_WIDTH / 2
      };
    });
    const cardWidth = cardBounds.length > 0
      ? Math.max(...cardBounds.map(bound => bound.right)) - Math.min(...cardBounds.map(bound => bound.left))
      : CARD_WIDTH;

    const layout = {
      offsets,
      reservedWidth,
      cardWidth: Math.max(CARD_WIDTH, cardWidth)
    };

    stack.delete(unitId);
    this.unitSlotLayouts.set(unitId, layout);
    return layout;
  }

  getUnitWidth(unitId, stack = new Set()) {
    return this.getUnitSlotLayout(unitId, stack).reservedWidth;
  }

  getPersonOffset(personId) {
    const unitId = this.unitByPerson.get(personId);
    return this.getUnitSlotLayout(unitId).offsets.get(personId) || 0;
  }

  getUnitFamilyOffset(unitId) {
    const personIds = this.units.get(unitId) || [];
    if (personIds.length <= 1) return 0;

    const offsets = personIds.map(personId => this.getPersonOffset(personId));
    return (Math.min(...offsets) + Math.max(...offsets)) / 2;
  }

  buildUnits() {
    const ids = Object.keys(this.people);
    const parent = new Map(ids.map(id => [id, id]));

    const find = (id) => {
      if (!parent.has(id)) return null;
      const current = parent.get(id);
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };

    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (!rootA || !rootB || rootA === rootB) return;

      const keep = this.comparePersonIds(rootA, rootB) <= 0 ? rootA : rootB;
      const move = keep === rootA ? rootB : rootA;
      parent.set(move, keep);
    };

    const parentsByChild = new Map();
    const addParentForChild = (childId, parentId) => {
      if (!this.people[childId] || !this.people[parentId]) return;
      if (!parentsByChild.has(childId)) parentsByChild.set(childId, new Set());
      parentsByChild.get(childId).add(parentId);
    };

    Object.values(this.people).forEach((person) => {
      if (person.partnerId && this.people[person.partnerId]) {
        union(person.id, person.partnerId);
      }

      addParentForChild(person.id, person.fatherId);
      addParentForChild(person.id, person.motherId);

      (person.children || []).forEach((childId) => {
        addParentForChild(childId, person.id);
      });
    });

    parentsByChild.forEach((parentIds) => {
      const idsToUnify = Array.from(parentIds);
      idsToUnify.slice(1).forEach(parentId => union(idsToUnify[0], parentId));
    });

    const grouped = new Map();
    ids.forEach((id) => {
      const root = find(id);
      if (!root) return;
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root).push(id);
    });

    grouped.forEach((personIds, unitId) => {
      const orderedPersonIds = [...personIds].sort((a, b) => this.comparePersonIds(a, b));
      this.units.set(unitId, orderedPersonIds);
      this.childrenByUnit.set(unitId, new Set());
      this.parentsByUnit.set(unitId, new Set());

      orderedPersonIds.forEach((personId) => {
        this.unitByPerson.set(personId, unitId);
      });
    });
  }

  addFamilyEdge(parentUnitId, childPersonId, seenEdges) {
    const childUnitId = this.unitByPerson.get(childPersonId);
    if (!parentUnitId || !childUnitId || parentUnitId === childUnitId) return;

    const key = `${parentUnitId}->${childPersonId}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);

    this.familyEdges.push({ parentUnitId, childUnitId, childPersonId });
    this.childrenByUnit.get(parentUnitId)?.add(childUnitId);
    this.parentsByUnit.get(childUnitId)?.add(parentUnitId);
  }

  buildGraph() {
    this.buildUnits();

    const seenEdges = new Set();
    Object.values(this.people).forEach((person) => {
      [person.fatherId, person.motherId].forEach((parentId) => {
        const parentUnitId = this.unitByPerson.get(parentId);
        this.addFamilyEdge(parentUnitId, person.id, seenEdges);
      });

      const parentUnitId = this.unitByPerson.get(person.id);
      (person.children || []).forEach((childId) => {
        if (!this.people[childId]) return;
        this.addFamilyEdge(parentUnitId, childId, seenEdges);
      });
    });
  }

  calculateGenerations() {
    this.buildGraph();

    const unitIds = Array.from(this.units.keys());
    const adjacency = new Map(unitIds.map(unitId => [unitId, []]));
    this.familyEdges.forEach((edge) => {
      adjacency.get(edge.parentUnitId)?.push({ unitId: edge.childUnitId, delta: 1 });
      adjacency.get(edge.childUnitId)?.push({ unitId: edge.parentUnitId, delta: -1 });
    });

    const rawGenerations = new Map();
    unitIds
      .sort((a, b) => this.compareUnitIds(a, b))
      .forEach((startUnitId) => {
        if (rawGenerations.has(startUnitId)) return;

        rawGenerations.set(startUnitId, 0);
        const queue = [startUnitId];
        while (queue.length > 0) {
          const unitId = queue.shift();
          const currentGeneration = rawGenerations.get(unitId) || 0;
          (adjacency.get(unitId) || []).forEach(({ unitId: nextUnitId, delta }) => {
            const nextGeneration = currentGeneration + delta;
            if (!rawGenerations.has(nextUnitId)) {
              rawGenerations.set(nextUnitId, nextGeneration);
              queue.push(nextUnitId);
            }
          });
        }
      });

    const minGeneration = Math.min(0, ...Array.from(rawGenerations.values()));
    rawGenerations.forEach((generation, unitId) => {
      this.unitGenerations.set(unitId, generation - minGeneration);
    });

    this.unitByPerson.forEach((unitId, personId) => {
      this.generations.set(personId, this.unitGenerations.get(unitId) || 0);
    });
  }

  buildLayerOrders() {
    const layers = new Map();
    this.unitGenerations.forEach((generation, unitId) => {
      if (!layers.has(generation)) layers.set(generation, []);
      layers.get(generation).push(unitId);
    });

    layers.forEach((unitIds) => {
      unitIds.sort((a, b) => this.compareUnitIds(a, b));
    });

    const generationKeys = Array.from(layers.keys()).sort((a, b) => a - b);

    const makeOrderIndex = () => {
      const index = new Map();
      generationKeys.forEach((generation) => {
        (layers.get(generation) || []).forEach((unitId, unitIndex) => {
          index.set(unitId, unitIndex);
        });
      });
      return index;
    };

    const barycenter = (neighborIds, orderIndex) => {
      const indexes = Array.from(neighborIds || [])
        .map(neighborId => orderIndex.get(neighborId))
        .filter(index => typeof index === 'number');
      if (indexes.length === 0) return null;
      return indexes.reduce((sum, index) => sum + index, 0) / indexes.length;
    };

    const childSideBarycenter = (parentUnitId, orderIndex) => {
      const scores = this.familyEdges
        .filter(edge => edge.parentUnitId === parentUnitId)
        .map((edge) => {
          const childOrder = orderIndex.get(edge.childUnitId);
          if (typeof childOrder !== 'number') return null;

          const childWidth = Math.max(this.getUnitWidth(edge.childUnitId), CARD_WIDTH);
          return childOrder + this.getPersonOffset(edge.childPersonId) / childWidth;
        })
        .filter(score => typeof score === 'number');

      if (scores.length === 0) return null;
      return scores.reduce((sum, score) => sum + score, 0) / scores.length;
    };

    for (let pass = 0; pass < 16; pass++) {
      let orderIndex = makeOrderIndex();
      generationKeys.slice(1).forEach((generation) => {
        const currentLayer = layers.get(generation) || [];
        const stableIndex = new Map(currentLayer.map((unitId, index) => [unitId, index]));
        currentLayer.sort((a, b) => {
          const centerA = barycenter(this.parentsByUnit.get(a), orderIndex);
          const centerB = barycenter(this.parentsByUnit.get(b), orderIndex);
          if (centerA !== null && centerB !== null && centerA !== centerB) return centerA - centerB;
          if (centerA !== null && centerB === null) return -1;
          if (centerA === null && centerB !== null) return 1;
          return stableIndex.get(a) - stableIndex.get(b);
        });
      });

      orderIndex = makeOrderIndex();
      generationKeys.slice(0, -1).reverse().forEach((generation) => {
        const currentLayer = layers.get(generation) || [];
        const stableIndex = new Map(currentLayer.map((unitId, index) => [unitId, index]));
        currentLayer.sort((a, b) => {
          const centerA = childSideBarycenter(a, orderIndex);
          const centerB = childSideBarycenter(b, orderIndex);
          if (centerA !== null && centerB !== null && centerA !== centerB) return centerA - centerB;
          if (centerA !== null && centerB === null) return -1;
          if (centerA === null && centerB !== null) return 1;
          return stableIndex.get(a) - stableIndex.get(b);
        });
      });
    }

    return { layers, generationKeys };
  }

  getLayerGap(leftUnitId, rightUnitId) {
    const leftParents = this.parentsByUnit.get(leftUnitId) || new Set();
    const rightParents = this.parentsByUnit.get(rightUnitId) || new Set();
    const shareParent = Array.from(leftParents).some(parentId => rightParents.has(parentId));

    const leftChildren = this.childrenByUnit.get(leftUnitId) || new Set();
    const rightChildren = this.childrenByUnit.get(rightUnitId) || new Set();
    const shareChild = Array.from(leftChildren).some(childId => rightChildren.has(childId));

    return shareParent || shareChild ? HORIZONTAL_GAP : BRANCH_GAP;
  }

  placeLayer(unitIds, desiredCenters, existingCenters = new Map()) {
    const centers = new Map();

    unitIds.forEach((unitId, index) => {
      const unitWidth = this.getUnitWidth(unitId);
      const desired = desiredCenters.get(unitId);
      const fallback = existingCenters.get(unitId);
      const previousUnitId = unitIds[index - 1];
      const previousCenter = previousUnitId ? centers.get(previousUnitId) : null;
      const previousWidth = previousUnitId ? this.getUnitWidth(previousUnitId) : 0;
      const gap = previousUnitId ? this.getLayerGap(previousUnitId, unitId) : 0;

      let ideal = Number.isFinite(desired) ? desired : fallback;
      if (!Number.isFinite(ideal)) {
        ideal = previousCenter === null
          ? unitWidth / 2
          : previousCenter + previousWidth / 2 + gap + unitWidth / 2;
      }

      const minimumCenter = previousCenter === null
        ? ideal
        : previousCenter + previousWidth / 2 + gap + unitWidth / 2;
      centers.set(unitId, Math.max(ideal, minimumCenter));
    });

    for (let index = unitIds.length - 2; index >= 0; index--) {
      const unitId = unitIds[index];
      const nextUnitId = unitIds[index + 1];
      const currentCenter = centers.get(unitId);
      const desired = desiredCenters.get(unitId);
      const ideal = Number.isFinite(desired) ? desired : existingCenters.get(unitId);
      if (!Number.isFinite(ideal) || currentCenter <= ideal) continue;

      const gap = this.getLayerGap(unitId, nextUnitId);
      const maximumCenter = centers.get(nextUnitId) - this.getUnitWidth(nextUnitId) / 2 - gap - this.getUnitWidth(unitId) / 2;
      const previousUnitId = unitIds[index - 1];
      const previousBound = previousUnitId
        ? centers.get(previousUnitId) + this.getUnitWidth(previousUnitId) / 2 + this.getLayerGap(previousUnitId, unitId) + this.getUnitWidth(unitId) / 2
        : -Infinity;

      if (maximumCenter >= previousBound) {
        const targetCenter = Math.max(previousBound, Math.min(ideal, maximumCenter));
        centers.set(unitId, Math.min(currentCenter, targetCenter));
      }
    }

    return centers;
  }

  calculateCoordinates(layers, generationKeys) {
    const centers = new Map();

    const getChildAnchorStats = (generation) => {
      const stats = new Map();
      const layerUnits = new Set(layers.get(generation) || []);

      this.familyEdges.forEach((edge) => {
        if (!layerUnits.has(edge.parentUnitId)) return;
        const childCenter = centers.get(edge.childUnitId);
        if (!Number.isFinite(childCenter)) return;

        const targetCenter = childCenter + this.getPersonOffset(edge.childPersonId) - this.getUnitFamilyOffset(edge.parentUnitId);
        const current = stats.get(edge.parentUnitId) || {
          sum: 0,
          count: 0,
          min: Infinity,
          max: -Infinity
        };

        current.sum += targetCenter;
        current.count += 1;
        current.min = Math.min(current.min, targetCenter);
        current.max = Math.max(current.max, targetCenter);
        stats.set(edge.parentUnitId, current);
      });

      stats.forEach((stat) => {
        stat.center = stat.sum / stat.count;
      });

      return stats;
    };

    const getDesiredCenters = (stats) => {
      const desired = new Map();
      stats.forEach((stat, unitId) => {
        desired.set(unitId, stat.center);
      });
      return desired;
    };

    generationKeys.slice().reverse().forEach((generation) => {
      const stats = getChildAnchorStats(generation);
      const desired = getDesiredCenters(stats);
      const currentLayer = layers.get(generation) || [];
      const stableIndex = new Map(currentLayer.map((unitId, index) => [unitId, index]));
      const orderedLayer = [...currentLayer].sort((a, b) => {
        const statsA = stats.get(a);
        const statsB = stats.get(b);
        if (statsA && statsB) {
          if (statsA.min !== statsB.min) return statsA.min - statsB.min;
          if (statsA.center !== statsB.center) return statsA.center - statsB.center;
          if (statsA.max !== statsB.max) return statsA.max - statsB.max;
        }
        if (statsA && !statsB) return -1;
        if (!statsA && statsB) return 1;
        return (stableIndex.get(a) || 0) - (stableIndex.get(b) || 0);
      });

      layers.set(generation, orderedLayer);
      const layerCenters = this.placeLayer(orderedLayer, desired, centers);
      layerCenters.forEach((center, unitId) => centers.set(unitId, center));
    });

    return centers;
  }

  calculateLayout() {
    this.calculateGenerations();
    const { layers, generationKeys } = this.buildLayerOrders();
    const centers = this.calculateCoordinates(layers, generationKeys);

    generationKeys.forEach((generation) => {
      const y = PADDING + generation * (CARD_HEIGHT + VERTICAL_GAP);
      (layers.get(generation) || []).forEach((unitId) => {
        const unitCenter = centers.get(unitId) || 0;
        const personIds = this.units.get(unitId) || [];
        this.unitLayouts.set(unitId, {
          x: unitCenter,
          y,
          width: this.getUnitWidth(unitId),
          generation,
          personIds
        });

        personIds.forEach((personId) => {
          this.positions.set(personId, {
            x: unitCenter + this.getPersonOffset(personId),
            y
          });
        });
      });
    });
  }

  getLayout() {
    this.calculateLayout();
    
    if (this.positions.size === 0) {
      return {
        positions: new Map(),
        canvasWidth: PADDING * 2,
        canvasHeight: PADDING * 2,
        units: new Map(),
        unitByPerson: new Map(),
        unitLayouts: new Map(),
        childrenByUnit: new Map(),
        parentsByUnit: new Map(),
        familyEdges: []
      };
    }

    let minX = Infinity;
    let minY = Infinity;
    
    this.positions.forEach(pos => {
      minX = Math.min(minX, pos.x - CARD_WIDTH / 2);
      minY = Math.min(minY, pos.y);
    });

    const offsetX = PADDING - minX;
    const offsetY = PADDING - minY;

    const normalizedPositions = new Map();
    this.positions.forEach((pos, id) => {
      normalizedPositions.set(id, {
        x: pos.x + offsetX,
        y: pos.y + offsetY
      });
    });

    const normalizedUnitLayouts = new Map();
    this.unitLayouts.forEach((layout, unitId) => {
      normalizedUnitLayouts.set(unitId, {
        ...layout,
        x: layout.x + offsetX,
        y: layout.y + offsetY
      });
    });

    let maxX = 0;
    let maxY = 0;
    
    normalizedPositions.forEach(pos => {
      maxX = Math.max(maxX, pos.x + CARD_WIDTH / 2);
      maxY = Math.max(maxY, pos.y + CARD_HEIGHT);
    });

    return {
      positions: normalizedPositions,
      canvasWidth: maxX + PADDING,
      canvasHeight: maxY + PADDING,
      units: this.units,
      unitByPerson: this.unitByPerson,
      unitLayouts: normalizedUnitLayouts,
      childrenByUnit: this.childrenByUnit,
      parentsByUnit: this.parentsByUnit,
      familyEdges: this.familyEdges
    };
  }
}

// ============================================
// CONNECTOR LINES COMPONENT
// ============================================

const TreeConnectors = ({ positions, layout, width, height }) => {
  const paths = useMemo(() => {
    const connectorPaths = [];
    const units = layout?.units || new Map();
    const unitLayouts = layout?.unitLayouts || new Map();
    const familyEdges = layout?.familyEdges || [];

    units.forEach((personIds, unitId) => {
      if (personIds.length < 2) return;

      const orderedPositions = personIds
        .map(personId => positions.get(personId))
        .filter(Boolean)
        .sort((a, b) => a.x - b.x);

      for (let index = 0; index < orderedPositions.length - 1; index++) {
        const left = orderedPositions[index];
        const right = orderedPositions[index + 1];
        const y = left.y + CARD_HEIGHT / 2;
        connectorPaths.push({
          key: `partners-${unitId}-${index}`,
          type: 'partner',
          d: `M ${left.x + CARD_WIDTH / 2} ${y} H ${right.x - CARD_WIDTH / 2}`
        });
      }
    });

    const edgesByParent = new Map();
    familyEdges.forEach((edge) => {
      if (!unitLayouts.has(edge.parentUnitId) || !positions.has(edge.childPersonId)) return;
      if (!edgesByParent.has(edge.parentUnitId)) edgesByParent.set(edge.parentUnitId, []);
      edgesByParent.get(edge.parentUnitId).push(edge);
    });

    edgesByParent.forEach((edges, parentUnitId) => {
      const parentLayout = unitLayouts.get(parentUnitId);
      const parentPersonIds = units.get(parentUnitId) || [];
      const childAnchors = edges
        .map((edge) => {
          const childPosition = positions.get(edge.childPersonId);
          if (!childPosition) return null;
          return {
            childPersonId: edge.childPersonId,
            x: childPosition.x,
            y: childPosition.y
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.x - b.x);

      if (!parentLayout || childAnchors.length === 0) return;

      const parentPosition = parentPersonIds.length === 1
        ? positions.get(parentPersonIds[0])
        : null;
      const startX = parentPersonIds.length === 1 && parentPosition
        ? parentPosition.x
        : (Math.min(...parentPersonIds.map(personId => positions.get(personId)?.x || parentLayout.x))
          + Math.max(...parentPersonIds.map(personId => positions.get(personId)?.x || parentLayout.x))) / 2;
      const parentBottomY = parentLayout.y + CARD_HEIGHT;
      const startY = parentPersonIds.length === 1
        ? parentBottomY
        : parentLayout.y + CARD_HEIGHT / 2;
      const childTopY = Math.min(...childAnchors.map(anchor => anchor.y));
      const branchY = childTopY > parentBottomY
        ? parentBottomY + (childTopY - parentBottomY) / 2
        : parentBottomY + 28;

      connectorPaths.push({
        key: `parent-stem-${parentUnitId}`,
        type: 'parent',
        d: `M ${startX} ${startY} V ${branchY}`
      });

      if (childAnchors.length === 1) {
        const child = childAnchors[0];
        connectorPaths.push({
          key: `parent-child-${parentUnitId}-${child.childPersonId}`,
          type: 'child',
          d: `M ${startX} ${branchY} H ${child.x} V ${child.y}`
        });
        return;
      }

      const leftX = Math.min(...childAnchors.map(anchor => anchor.x));
      const rightX = Math.max(...childAnchors.map(anchor => anchor.x));
      connectorPaths.push({
        key: `children-branch-${parentUnitId}`,
        type: 'child',
        d: `M ${leftX} ${branchY} H ${rightX}`
      });

      childAnchors.forEach((child) => {
        connectorPaths.push({
          key: `parent-child-${parentUnitId}-${child.childPersonId}`,
          type: 'child',
          d: `M ${child.x} ${branchY} V ${child.y}`
        });
      });
    });

    return connectorPaths;
  }, [positions, layout]);

  return (
    <svg className="tree-connectors" width={width} height={height}>
      {paths.map(path => (
        <path
          key={path.key}
          className={`tree-connector ${path.type}`}
          d={path.d}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
};

// ============================================
// PERSON NODE COMPONENT
// ============================================

const PersonNode = ({ person, position, isSelected, onClick, onMatchClick }) => {
  const fullName = getFullName(person);
  const birthYear = extractBirthYear(person.birthDate);

  const handleMatchClick = (e) => {
    e.stopPropagation();
    if (onMatchClick) {
      onMatchClick(person);
    }
  };

  return (
    <div 
      className={`person-node ${person.gender} ${isSelected ? 'selected' : ''}`}
      style={{
        left: position.x,
        top: position.y
      }}
      onClick={() => onClick(person)}
    >
      {person.hasMatch && (
        <div className="match-indicator-wrapper">
          <button 
            className="match-indicator"
            onClick={handleMatchClick}
          >
            <FourPointStar size={14} />
          </button>
          <div className="match-tooltip">
            Умный поиск — позволяет находить ваших родственников в деревьях других людей и архивных данных.
          </div>
        </div>
      )}
      <div className="person-avatar">
        <User size={20} />
      </div>
      <div className="person-name">{fullName || 'Без имени'}</div>
      {birthYear && <div className="person-dates">{birthYear}</div>}
    </div>
  );
};

// ============================================
// FAMILY TREE COMPONENT
// ============================================

const FamilyTree = ({
  people,
  selectedPerson,
  onSelectPerson,
  onMatchClick,
  zoom,
  pan,
  onPanChange,
  collapsedGroups,
  onToggleGroup
}) => {
  const layout = useMemo(() => {
    const engine = new TreeLayoutEngine(people);
    return engine.getLayout();
  }, [people]);

  const containerRef = useRef(null);
  const isPanning = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e) => {
    // Left mouse button for panning
    if (e.button === 0) {
      isPanning.current = true;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e) => {
    if (isPanning.current && onPanChange) {
      const deltaX = e.clientX - lastMousePos.current.x;
      const deltaY = e.clientY - lastMousePos.current.y;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      onPanChange(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY
      }));
    }
  };

  const handleMouseUp = (e) => {
    if (e.button === 0) {
      isPanning.current = false;
    }
  };

  const peopleArray = Object.values(people);

  if (peopleArray.length === 0) {
    return (
      <div className="empty-state">
        <TreePine size={80} />
        <h2>Семейное древо пусто</h2>
        <p>Начните добавлять членов семьи</p>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="tree-viewport"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => { isPanning.current = false; }}
    >
      <div 
        className="tree-canvas" 
        style={{ 
          width: layout.canvasWidth, 
          height: layout.canvasHeight,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center'
        }}
      >
        <TreeConnectors 
          positions={layout.positions}
          layout={layout}
          width={layout.canvasWidth}
          height={layout.canvasHeight}
        />
        <div className="tree-nodes">
          {peopleArray.map(person => {
            const position = layout.positions.get(person.id);
            if (!position) return null;

            return (
              <PersonNode
                key={person.id}
                person={person}
                position={position}
                isSelected={selectedPerson?.id === person.id}
                onClick={onSelectPerson}
                onMatchClick={onMatchClick}
              />
            );
          })}
        </div>
        <div className="tree-group-controls">
          {(collapsedGroups || []).map(group => {
            const position = layout.positions.get(group.anchorId);
            if (!position) return null;
            return (
              <button
                key={group.key}
                className="tree-group-toggle"
                style={{ left: position.x + CARD_WIDTH / 2 + 12, top: position.y + 8 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleGroup?.(group.key);
                }}
              >
                <Plus size={12} />
                {`показать еще ${group.count}`}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ============================================
// MODAL COMPONENTS
// ============================================

// Toast Component
const Toast = ({ message, type, onClose }) => {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => onCloseRef.current(), 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`toast ${type}`}>
      <div className="toast-icon">
        {type === 'success' ? <Check size={20} /> : <AlertTriangle size={20} />}
      </div>
      <span className="toast-message">{message}</span>
    </div>
  );
};

// Confirm Dialog Component
const ConfirmDialog = ({ isOpen, title, message, onConfirm, onCancel }) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay confirm-dialog" onClick={onCancel}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="confirm-dialog-body">
          <div className="confirm-icon">
            <AlertTriangle size={28} />
          </div>
          <h3 className="confirm-title">{title}</h3>
          <p className="confirm-message">{message}</p>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-secondary" onClick={onCancel}>
            Отмена
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
};

// Edit Person Modal
const EditModal = ({ isOpen, person, onSave, onClose }) => {
  const [formData, setFormData] = useState({
    name: '',
    lastName: '',
    middleName: '',
    birthDate: '',
    birthPlace: '',
    information: '',
    documents: []
  });

  useEffect(() => {
    if (person) {
      setFormData({
        name: person.name || '',
        lastName: person.lastName || '',
        middleName: person.middleName || '',
        birthDate: formatDateForInput(person.birthDate),
        birthPlace: person.birthPlace || '',
        information: person.information || '',
        documents: Array.isArray(person.documents) ? person.documents : []
      });
    }
  }, [person]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    const birthDate = normalizePartialDate(formData.birthDate);
    if (formData.birthDate.trim() && !birthDate) {
      const input = e.currentTarget.elements.birthDate;
      input?.setCustomValidity(PARTIAL_DATE_ERROR);
      e.currentTarget.reportValidity();
      return;
    }
    onSave({ ...formData, birthDate });
  };

  return (
    <div className="modal-overlay edit-modal" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="edit-modal-header">
          <h3 className="edit-modal-title">Редактировать</h3>
          <button className="card-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="edit-modal-body">
            <div className="form-group">
              <label className="form-label">Фамилия</label>
              <input
                type="text"
                className="form-input"
                value={formData.lastName}
                onChange={e => setFormData({...formData, lastName: e.target.value})}
                placeholder="Введите фамилию"
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Имя</label>
                <input
                  type="text"
                  className="form-input"
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  placeholder="Введите имя"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Отчество</label>
                <input
                  type="text"
                  className="form-input"
                  value={formData.middleName}
                  onChange={e => setFormData({...formData, middleName: e.target.value})}
                  placeholder="Введите отчество"
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Дата рождения</label>
              <PartialDateInput
                value={formData.birthDate}
                onChange={birthDate => setFormData({...formData, birthDate})}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Место рождения</label>
              <input
                type="text"
                className="form-input"
                value={formData.birthPlace}
                onChange={e => setFormData({...formData, birthPlace: e.target.value})}
                placeholder="Введите место рождения"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Описание</label>
              <textarea
                className="form-input form-textarea"
                value={formData.information}
                onChange={e => setFormData({...formData, information: e.target.value})}
                placeholder="Введите описание"
                rows={4}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Документы</label>
              {formData.documents.length === 0 ? (
                <p className="form-help-text">Нет добавленных документов</p>
              ) : (
                <div className="edit-documents-list">
                  {formData.documents.map((document, index) => (
                    <article key={`${getDocumentKey(document)}-${index}`} className="smart-source-result-item">
                      <div className="smart-source-result-header">
                        <div className="smart-source-header-left">
                          <button
                            type="button"
                            className="smart-source-remove-btn"
                            title="Удалить документ"
                            onClick={() => {
                              setFormData((prev) => ({
                                ...prev,
                                documents: prev.documents.filter((_, itemIndex) => itemIndex !== index)
                              }));
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                          <span className={`smart-source-name ${getDocumentSourceClass(document.sourceLabel)}`.trim()}>
                            {document.sourceLabel || 'Источник'}
                          </span>
                        </div>
                      </div>
                      <p className="smart-source-title">
                        {document.url ? (
                          <a
                            href={document.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="smart-source-link"
                            title="Открыть документ в источнике"
                          >
                            {document.title || 'Документ'}
                          </a>
                        ) : (
                          document.title || 'Документ'
                        )}
                      </p>
                      {document.birthDate && (
                        <p className="smart-source-meta">Дата рождения: {formatDate(document.birthDate)}</p>
                      )}
                      {document.birthPlace && (
                        <p className="smart-source-meta">Место рождения: {document.birthPlace}</p>
                      )}
                      {document.information && (
                        <p className="smart-source-meta">{document.information}</p>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="edit-modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn btn-primary">
              Сохранить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Add Relative Modal
const AddRelativeModal = ({ isOpen, person, availableRelations, initialRelation, onAdd, onClose }) => {
  const [selectedRelation, setSelectedRelation] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    lastName: '',
    middleName: '',
    birthDate: '',
    birthPlace: '',
    information: ''
  });

  useEffect(() => {
    if (isOpen) {
      setSelectedRelation(initialRelation || (availableRelations?.[0] || null));
      setFormData({
        name: '',
        lastName: '',
        middleName: '',
        birthDate: '',
        birthPlace: '',
        information: ''
      });
    }
  }, [isOpen, initialRelation, availableRelations]);

  if (!isOpen) return null;

  const relationLabels = {
    partner: { label: 'Партнёр', icon: Heart },
    father: { label: 'Отец', icon: User },
    mother: { label: 'Мать', icon: User },
    son: { label: 'Сын', icon: Baby },
    daughter: { label: 'Дочь', icon: Baby }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (selectedRelation) {
      const birthDate = normalizePartialDate(formData.birthDate);
      if (formData.birthDate.trim() && !birthDate) {
        const input = e.currentTarget.elements.birthDate;
        input?.setCustomValidity(PARTIAL_DATE_ERROR);
        e.currentTarget.reportValidity();
        return;
      }
      onAdd(selectedRelation, { ...formData, birthDate });
    }
  };

  return (
    <div className="modal-overlay edit-modal" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="edit-modal-header">
          <h3 className="edit-modal-title">Добавить родственника</h3>
          <button className="card-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="edit-modal-body">
            {selectedRelation ? (
              <>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px', 
                  marginBottom: '20px',
                  padding: '10px 14px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '8px'
                }}>
                  {(() => {
                    const { label, icon: Icon } = relationLabels[selectedRelation];
                    return (
                      <>
                        <Icon size={18} />
                        <span style={{ fontSize: '0.9rem' }}>Добавление: {label}</span>
                      </>
                    );
                  })()}
                </div>
                <div className="form-group">
                  <label className="form-label">Фамилия</label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.lastName}
                    onChange={e => setFormData({...formData, lastName: e.target.value})}
                    placeholder="Введите фамилию"
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Имя</label>
                    <input
                      type="text"
                      className="form-input"
                      value={formData.name}
                      onChange={e => setFormData({...formData, name: e.target.value})}
                      placeholder="Введите имя"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Отчество</label>
                    <input
                      type="text"
                      className="form-input"
                      value={formData.middleName}
                      onChange={e => setFormData({...formData, middleName: e.target.value})}
                      placeholder="Введите отчество"
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Дата рождения</label>
                  <PartialDateInput
                    value={formData.birthDate}
                    onChange={birthDate => setFormData({...formData, birthDate})}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Место рождения</label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.birthPlace}
                    onChange={e => setFormData({...formData, birthPlace: e.target.value})}
                    placeholder="Введите место рождения"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Описание</label>
                  <textarea
                    className="form-input form-textarea"
                    value={formData.information}
                    onChange={e => setFormData({...formData, information: e.target.value})}
                    placeholder="Введите описание"
                    rows={3}
                  />
                </div>
              </>
            ) : null}
          </div>
          <div className="edit-modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Отмена
            </button>
            {selectedRelation && (
              <button type="submit" className="btn btn-primary">
                Добавить
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

// Person Card Modal
const PersonCard = ({ person, people, onClose, onEdit, onAddRelative, onDelete, onSelectPerson }) => {
  const [showDropdown, setShowDropdown] = useState(false);

  if (!person) return null;

  const fullName = getFullName(person);
  
  // Get family members
  const partner = person.partnerId ? people[person.partnerId] : null;
  const father = person.fatherId ? people[person.fatherId] : null;
  const mother = person.motherId ? people[person.motherId] : null;
  const children = (person.children || []).map(id => people[id]).filter(Boolean);
  const documents = Array.isArray(person.documents) ? person.documents : [];
  
  // Get siblings
  const siblings = Object.values(people).filter(p => {
    if (p.id === person.id) return false;
    const sameFather = person.fatherId && p.fatherId === person.fatherId;
    const sameMother = person.motherId && p.motherId === person.motherId;
    return sameFather || sameMother;
  });

  // Determine available relations to add
  const availableRelations = [];
  if (!partner) availableRelations.push('partner');
  if (!father) availableRelations.push('father');
  if (!mother) availableRelations.push('mother');
  availableRelations.push('son', 'daughter');

  const handleRelativeClick = (relativePerson) => {
    onSelectPerson(relativePerson);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content person-card" onClick={e => e.stopPropagation()}>
        <div className="card-header">
          <div className={`card-avatar ${person.gender}`}>
            <User size={28} />
          </div>
          <div className="card-title-section">
            <h2 className="card-name">{fullName || 'Без имени'}</h2>
            <p className="card-meta">
              {person.gender === 'male' ? 'Мужчина' : 'Женщина'}
            </p>
          </div>
          <button className="card-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        
        <div className="card-body">
          <div className="card-actions-top">
            <div className="dropdown" style={{ position: 'relative' }}>
              <button 
                className="btn btn-add-relative"
                onClick={() => setShowDropdown(!showDropdown)}
              >
                <UserPlus size={16} />
                + Родственник
                <ChevronDown size={16} />
              </button>
              {showDropdown && (
                <div className="dropdown-menu" style={{ minWidth: '160px' }}>
                  {availableRelations.map(relation => (
                    <div 
                      key={relation}
                      className="dropdown-item"
                      onClick={() => {
                        setShowDropdown(false);
                        onAddRelative(relation);
                      }}
                    >
                      {relation === 'partner' && <><Heart size={16} /> Партнёр</>}
                      {relation === 'father' && <><User size={16} /> Отец</>}
                      {relation === 'mother' && <><User size={16} /> Мать</>}
                      {relation === 'son' && <><Baby size={16} /> Сын</>}
                      {relation === 'daughter' && <><Baby size={16} /> Дочь</>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="btn btn-edit-outline" onClick={onEdit}>
              <Edit2 size={16} />
              Редактировать
            </button>
          </div>

          <div className="card-section">
            <h4 className="card-section-title">Информация</h4>
            
            <div className="card-info-row">
              <div className="card-info-icon">
                <Calendar size={18} />
              </div>
              <div className="card-info-content">
                <p className="card-info-label">Дата рождения</p>
                <p className="card-info-value">{formatDate(person.birthDate)}</p>
              </div>
            </div>
            
            <div className="card-info-row">
              <div className="card-info-icon">
                <MapPin size={18} />
              </div>
              <div className="card-info-content">
                <p className="card-info-label">Место рождения</p>
                <p className="card-info-value">{person.birthPlace || 'Не указано'}</p>
              </div>
            </div>
          </div>

          {partner && (
            <div className="card-section">
              <h4 className="card-section-title">Супруг(а)</h4>
              <div className="relative-list">
                <span 
                  className={`relative-tag ${partner.gender}`}
                  onClick={() => handleRelativeClick(partner)}
                >
                  {getFullName(partner)}
                </span>
              </div>
            </div>
          )}

          {(father || mother) && (
            <div className="card-section">
              <h4 className="card-section-title">Родители</h4>
              <div className="relative-list">
                {father && (
                  <span 
                    className="relative-tag male"
                    onClick={() => handleRelativeClick(father)}
                  >
                    {getFullName(father)} (отец)
                  </span>
                )}
                {mother && (
                  <span 
                    className="relative-tag female"
                    onClick={() => handleRelativeClick(mother)}
                  >
                    {getFullName(mother)} (мать)
                  </span>
                )}
              </div>
            </div>
          )}

          {children.length > 0 && (
            <div className="card-section">
              <h4 className="card-section-title">Дети</h4>
              <div className="relative-list">
                {children.map(child => (
                  <span 
                    key={child.id}
                    className={`relative-tag ${child.gender}`}
                    onClick={() => handleRelativeClick(child)}
                  >
                    {getFullName(child)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {siblings.length > 0 && (
            <div className="card-section">
              <h4 className="card-section-title">Братья/Сёстры</h4>
              <div className="relative-list">
                {siblings.map(sibling => (
                  <span 
                    key={sibling.id}
                    className={`relative-tag ${sibling.gender}`}
                    onClick={() => handleRelativeClick(sibling)}
                  >
                    {getFullName(sibling)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {person.information && (
            <div className="card-section">
              <h4 className="card-section-title">Описание</h4>
              <p className="card-description">{person.information}</p>
            </div>
          )}

          {documents.length > 0 && (
            <div className="card-section">
              <h4 className="card-section-title">Документы</h4>
              <div className="card-documents-list">
                {documents.map((document, index) => (
                  <article key={`${getDocumentKey(document)}-${index}`} className="smart-source-result-item">
                    <div className="smart-source-result-header">
                      <span className={`smart-source-name ${getDocumentSourceClass(document.sourceLabel)}`.trim()}>
                        {document.sourceLabel || 'Источник'}
                      </span>
                    </div>
                    <p className="smart-source-title">
                      {document.url ? (
                        <a
                          href={document.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="smart-source-link"
                          title="Открыть документ в источнике"
                        >
                          {document.title || 'Документ'}
                        </a>
                      ) : (
                        document.title || 'Документ'
                      )}
                    </p>
                    {document.birthDate && (
                      <p className="smart-source-meta">Дата рождения: {formatDate(document.birthDate)}</p>
                    )}
                    {document.birthPlace && (
                      <p className="smart-source-meta">Место рождения: {document.birthPlace}</p>
                    )}
                    {document.information && (
                      <p className="smart-source-meta">{document.information}</p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="card-actions card-actions-bottom">
          <button className="btn btn-delete-ghost" onClick={onDelete}>
            <Trash2 size={16} />
            Удалить родственника
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================
// BALANCE PANEL
// ============================================

const BalancePanel = ({ balance, onAddBalance, onClose }) => {
  const [showReplenishModal, setShowReplenishModal] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [selectedPlan, setSelectedPlan] = useState('basic');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const basicPrice = 210;
  const packagePrice = 1600;

  const handleBuy = async () => {
    setIsProcessing(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    setIsProcessing(false);
    setShowSuccess(true);
    
    const matchesToAdd = selectedPlan === 'package' ? 10 : quantity;
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    setShowSuccess(false);
    setShowReplenishModal(false);
    onAddBalance(matchesToAdd);
  };

  return (
    <>
      <div className="balance-panel">
        <div className="balance-header">
          <h4>Баланс</h4>
        </div>
        <div className="balance-content">
          <div className="balance-amount">
            <FourPointStar size={18} />
            <span className="balance-value">{balance}</span>
            <span className="balance-label">Совпадений</span>
          </div>
          <button 
            className="btn btn-primary balance-replenish-btn"
            onClick={() => setShowReplenishModal(true)}
          >
            <Plus size={16} />
            Пополнить
          </button>
        </div>
      </div>

      {showReplenishModal && (
        <div className="modal-overlay payment-modal" onClick={() => !isProcessing && setShowReplenishModal(false)}>
          <div className="modal-content payment-content" onClick={e => e.stopPropagation()}>
            {showSuccess ? (
              <div className="payment-success">
                <Check size={48} className="success-icon" />
                <h3>Оплата прошла успешно!</h3>
                <p>Добавлено {selectedPlan === 'package' ? 10 : quantity} совпадений</p>
              </div>
            ) : (
              <>
                <div className="payment-header">
                  <CreditCard size={32} className="payment-icon" />
                  <h3>Пополнение баланса</h3>
                </div>
                <div className="payment-plans">
                  <div 
                    className={`payment-plan ${selectedPlan === 'basic' ? 'selected' : ''}`}
                    onClick={() => setSelectedPlan('basic')}
                  >
                    <div className="plan-header">
                      <h4>Базовый</h4>
                      <span className="plan-price">{basicPrice} ₽</span>
                    </div>
                    <p className="plan-desc">за 1 совпадение</p>
                    <div className="plan-quantity">
                      <button 
                        className="quantity-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQuantity(prev => Math.max(1, prev - 1));
                        }}
                        disabled={quantity <= 1}
                      >
                        <Minus size={14} />
                      </button>
                      <span className="quantity-value">{quantity}</span>
                      <button 
                        className="quantity-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQuantity(prev => prev + 1);
                        }}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <div className="plan-total">
                      Итого: <strong>{quantity * basicPrice} ₽</strong>
                    </div>
                  </div>

                  <div 
                    className={`payment-plan package ${selectedPlan === 'package' ? 'selected' : ''}`}
                    onClick={() => setSelectedPlan('package')}
                  >
                    <div className="plan-badge">Выгодно</div>
                    <div className="plan-header">
                      <h4>Пакет</h4>
                      <span className="plan-price">{packagePrice} ₽</span>
                    </div>
                    <p className="plan-desc">за 10 совпадений</p>
                    <p className="plan-savings">Экономия {10 * basicPrice - packagePrice} ₽</p>
                    <div className="plan-total">
                      <strong>{packagePrice} ₽</strong>
                    </div>
                  </div>
                </div>

                <button 
                  className="btn btn-primary payment-btn"
                  onClick={handleBuy}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <>
                      <div className="btn-spinner" />
                      Обработка...
                    </>
                  ) : (
                    <>
                      <CreditCard size={16} />
                      Оплатить {selectedPlan === 'package' ? packagePrice : quantity * basicPrice} ₽
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};

// ============================================
// MATCH VERIFICATION MODAL
// ============================================

const MatchVerificationModal = ({ 
  isOpen, 
  person, 
  treeMatches = [], 
  archiveMatches = [], 
  onConfirmTree, 
  onConfirmArchive, 
  onClose,
  smartMatchBalance,
  onAddBalance,
  onSpendBalance,
  grantedAccessIds,
  onGrantAccess
}) => {
  const [expandedMatch, setExpandedMatch] = useState(null);
  const [expandedArchive, setExpandedArchive] = useState(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showConfirmPurchaseModal, setShowConfirmPurchaseModal] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [currentRequestMatch, setCurrentRequestMatch] = useState(null);
  const [requestMessage, setRequestMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showPaymentSuccess, setShowPaymentSuccess] = useState(false);
  const [requiredMatches, setRequiredMatches] = useState(1);
  const [selectedPlan, setSelectedPlan] = useState('basic');
  const [basicQuantity, setBasicQuantity] = useState(1);

  if (!isOpen || !person) return null;

  // Sort matches by score descending
  const sortedTreeMatches = [...(treeMatches || [])].sort((a, b) => b.score - a.score);
  const sortedArchiveMatches = [...(archiveMatches || [])].sort((a, b) => b.score - a.score);

  const hasAnyMatches = sortedTreeMatches.length > 0 || sortedArchiveMatches.length > 0;

  const toggleExpand = (matchIndex) => {
    setExpandedMatch(expandedMatch === matchIndex ? null : matchIndex);
  };

  const toggleArchiveExpand = (matchIndex) => {
    setExpandedArchive(expandedArchive === matchIndex ? null : matchIndex);
  };

  const getRelativesFromFragment = (match) => {
    if (!match.people) return [];
    const matchedPersonId = match.database_id;
    return Object.values(match.people).filter(p => p.id !== matchedPersonId);
  };

  const handleRequestAccess = (match) => {
    const relatives = getRelativesFromFragment(match);
    const relativesCount = relatives.length;
    setCurrentRequestMatch(match);
    setRequiredMatches(relativesCount);
    
    if (smartMatchBalance >= relativesCount) {
      // Sufficient balance - show confirmation modal
      setShowConfirmPurchaseModal(true);
    } else {
      // Insufficient balance - show payment modal first
      setBasicQuantity(relativesCount);
      setSelectedPlan('basic');
      setShowPaymentModal(true);
    }
  };

  const handleConfirmPurchase = () => {
    setShowConfirmPurchaseModal(false);
    // Proceed to request modal
    if (currentRequestMatch) {
      setRequestMessage(`Здравствуйте, ${currentRequestMatch.tree_owner}! Я хотел бы получить доступ к данным вашего семейного древа.`);
      setShowRequestModal(true);
    }
  };

  const handleCancelPurchase = () => {
    setShowConfirmPurchaseModal(false);
    setCurrentRequestMatch(null);
  };

  const handleBuyMatches = async () => {
    setIsProcessing(true);
    // Simulate payment processing
    await new Promise(resolve => setTimeout(resolve, 2000));
    setIsProcessing(false);
    setShowPaymentSuccess(true);
    
    // Calculate matches to add
    const matchesToAdd = selectedPlan === 'package' ? 10 : basicQuantity;
    
    // After showing success, add balance and close
    await new Promise(resolve => setTimeout(resolve, 1500));
    setShowPaymentSuccess(false);
    setShowPaymentModal(false);
    onAddBalance(matchesToAdd);
    
    // Now show confirmation modal if we came from a match request
    if (currentRequestMatch) {
      setShowConfirmPurchaseModal(true);
    }
  };

  const handleSendRequest = async () => {
    setIsProcessing(true);
    // Simulate sending request and getting access
    await new Promise(resolve => setTimeout(resolve, 2000));
    setIsProcessing(false);
    
    if (currentRequestMatch) {
      const relatives = getRelativesFromFragment(currentRequestMatch);
      onSpendBalance(relatives.length);
      onGrantAccess(currentRequestMatch.tree_id);
    }
    setShowRequestModal(false);
    setCurrentRequestMatch(null);
  };

  const hasAccessToMatch = (match) => {
    return grantedAccessIds?.includes(match.tree_id);
  };

  // Payment Modal with rates
  const PaymentModal = () => {
    const basicPrice = 210;
    const packagePrice = 1600;
    const basicTotal = basicQuantity * basicPrice;

    return (
      <div className="modal-overlay payment-modal" onClick={() => !isProcessing && setShowPaymentModal(false)}>
        <div className="modal-content payment-content" onClick={e => e.stopPropagation()}>
          {showPaymentSuccess ? (
            <div className="payment-success">
              <Check size={48} className="success-icon" />
              <h3>Оплата прошла успешно!</h3>
              <p>Добавлено {selectedPlan === 'package' ? 10 : basicQuantity} совпадений</p>
            </div>
          ) : (
            <>
              <div className="payment-header">
                <CreditCard size={32} className="payment-icon" />
                <h3>Пополнение баланса</h3>
              </div>
              {requiredMatches > 1 && (
                <p className="payment-notice">
                  Для добавления родственников требуется минимум {requiredMatches} совпадений
                </p>
              )}
              <div className="payment-plans">
                <div 
                  className={`payment-plan ${selectedPlan === 'basic' ? 'selected' : ''}`}
                  onClick={() => setSelectedPlan('basic')}
                >
                  <div className="plan-header">
                    <h4>Базовый</h4>
                    <span className="plan-price">{basicPrice} ₽</span>
                  </div>
                  <p className="plan-desc">за 1 совпадение</p>
                  <div className="plan-quantity">
                    <button 
                      className="quantity-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBasicQuantity(prev => Math.max(requiredMatches || 1, prev - 1));
                      }}
                      disabled={basicQuantity <= (requiredMatches || 1)}
                    >
                      <Minus size={14} />
                    </button>
                    <span className="quantity-value">{basicQuantity}</span>
                    <button 
                      className="quantity-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBasicQuantity(prev => prev + 1);
                      }}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="plan-total">
                    Итого: <strong>{basicTotal} ₽</strong>
                  </div>
                </div>

                <div 
                  className={`payment-plan package ${selectedPlan === 'package' ? 'selected' : ''}`}
                  onClick={() => setSelectedPlan('package')}
                >
                  <div className="plan-badge">Выгодно</div>
                  <div className="plan-header">
                    <h4>Пакет</h4>
                    <span className="plan-price">{packagePrice} ₽</span>
                  </div>
                  <p className="plan-desc">за 10 совпадений</p>
                  <p className="plan-savings">Экономия {10 * basicPrice - packagePrice} ₽</p>
                  <div className="plan-total">
                    <strong>{packagePrice} ₽</strong>
                  </div>
                </div>
              </div>

              <button 
                className="btn btn-primary payment-btn"
                onClick={handleBuyMatches}
                disabled={isProcessing}
              >
                {isProcessing ? (
                  <>
                    <div className="btn-spinner" />
                    Обработка...
                  </>
                ) : (
                  <>
                    <CreditCard size={16} />
                    Оплатить {selectedPlan === 'package' ? packagePrice : basicTotal} ₽
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  // Confirm Purchase Modal
  const ConfirmPurchaseModal = () => {
    const relatives = currentRequestMatch ? getRelativesFromFragment(currentRequestMatch) : [];
    const relativesCount = relatives.length;

    return (
      <div className="modal-overlay confirm-purchase-modal" onClick={handleCancelPurchase}>
        <div className="modal-content confirm-purchase-content" onClick={e => e.stopPropagation()}>
          <div className="confirm-purchase-header">
            <FourPointStar size={24} className="confirm-purchase-icon" />
            <h3>Подтверждение</h3>
          </div>
          <p className="confirm-purchase-text">
            Вы хотите добавить <strong>{relativesCount}</strong> {relativesCount === 1 ? 'родственника' : relativesCount < 5 ? 'родственников' : 'родственников'} за <strong>{relativesCount} совпадений</strong>?
          </p>
          <p className="confirm-purchase-balance">
            Текущий баланс: <strong>{smartMatchBalance}</strong> совпадений
          </p>
          <div className="confirm-purchase-actions">
            <button 
              className="btn btn-secondary"
              onClick={handleCancelPurchase}
            >
              Отмена
            </button>
            <button 
              className="btn btn-primary"
              onClick={handleConfirmPurchase}
            >
              <Check size={16} />
              Подтвердить
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Request Access Modal
  const RequestModal = () => (
    <div className="modal-overlay request-modal" onClick={() => !isProcessing && setShowRequestModal(false)}>
      <div className="modal-content request-content" onClick={e => e.stopPropagation()}>
        <div className="request-header">
          <Send size={24} className="request-icon" />
          <h3>Запрос доступа</h3>
        </div>
        <p className="request-recipient">
          Кому: <strong>{currentRequestMatch?.tree_owner}</strong>
        </p>
        <textarea
          className="request-textarea"
          value={requestMessage}
          onChange={(e) => setRequestMessage(e.target.value)}
          rows={4}
          disabled={isProcessing}
        />
        <button 
          className="btn btn-primary request-btn"
          onClick={handleSendRequest}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <>
              <div className="btn-spinner" />
              Отправка...
            </>
          ) : (
            <>
              <Send size={16} />
              Отправить
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="modal-overlay match-modal" onClick={onClose}>
        <div className="modal-content match-verification-content" onClick={e => e.stopPropagation()}>
          <div className="edit-modal-header">
            <h3 className="edit-modal-title">Проверка совпадений</h3>
            <button className="card-close" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
          
          <div className="match-modal-body">
            {!hasAnyMatches ? (
              <p className="no-matches">Совпадения не найдены</p>
            ) : (
              <>
                {/* Tree matches section */}
                {sortedTreeMatches.length > 0 && (
                  <div className="match-section">
                    <h4 className="match-section-title">Совпадения с деревьями других пользователей</h4>
                    {sortedTreeMatches.map((match, index) => {
                      const matchedPerson = match.people?.[match.database_id];
                      const relatives = getRelativesFromFragment(match);
                      const isExpanded = expandedMatch === index;
                      const hasAccess = hasAccessToMatch(match);

                      return (
                        <div key={`tree-${index}`} className="match-card">
                          <div className="match-comparison">
                            <div className="match-person current-person">
                              <h4 className="match-person-title">Ваше дерево</h4>
                              <div className="match-person-info">
                                <p className="match-name">{getFullName(person)}</p>
                                <p className="match-detail">
                                  <Calendar size={14} />
                                  {formatDate(person.birthDate)}
                                </p>
                                <p className="match-detail">
                                  <MapPin size={14} />
                                  {person.birthPlace || 'Не указано'}
                                </p>
                              </div>
                            </div>

                            <div className="match-arrow">
                              <FourPointStar size={18} />
                            </div>

                            <div className="match-person found-person">
                              <h4 className="match-person-title">Дерево: {match.tree_owner}</h4>
                              <div className={`match-person-info ${!hasAccess ? 'blurred-info' : ''}`}>
                                <p className="match-name">{matchedPerson ? getFullName(matchedPerson) : 'Неизвестно'}</p>
                                <p className="match-detail">
                                  <Calendar size={14} />
                                  {formatDate(matchedPerson?.birthDate)}
                                </p>
                                <p className="match-detail">
                                  <MapPin size={14} />
                                  {matchedPerson?.birthPlace || 'Не указано'}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="match-score">
                            <span className="score-label">Вероятность совпадения:</span>
                            <span className="score-value">{match.score?.toFixed(1)}%</span>
                          </div>

                          {relatives.length > 0 && (
                            <div className="match-relatives-section">
                              {hasAccess ? (
                                <>
                                  <button 
                                    className="match-relatives-toggle"
                                    onClick={() => toggleExpand(index)}
                                  >
                                    <Users size={16} />
                                    <span>Родственники для добавления ({relatives.length})</span>
                                    <ChevronRight 
                                      size={16} 
                                      className={`toggle-icon ${isExpanded ? 'expanded' : ''}`}
                                    />
                                  </button>
                                  
                                  {isExpanded && (
                                    <div className="match-relatives-list">
                                      {relatives.map((relative, relIndex) => (
                                        <div key={relIndex} className="match-relative-item">
                                          <p className="relative-name">{getFullName(relative)}</p>
                                          <p className="relative-detail">
                                            <Calendar size={12} />
                                            {formatDate(relative.birthDate)}
                                          </p>
                                          <p className="relative-detail">
                                            <MapPin size={12} />
                                            {relative.birthPlace || 'Не указано'}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="match-relatives-locked">
                                  <Lock size={16} />
                                  <span>Родственники для добавления ({relatives.length})</span>
                                </div>
                              )}
                            </div>
                          )}

                          {hasAccess ? (
                            <button 
                              className="btn btn-primary match-confirm-btn"
                              onClick={() => onConfirmTree(match)}
                            >
                              <Check size={16} />
                              Подтвердить совпадение
                            </button>
                          ) : (
                            <button 
                              className="btn btn-secondary match-request-btn"
                              onClick={() => handleRequestAccess(match)}
                            >
                              <Lock size={16} />
                              Запросить доступ
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Archive matches section */}
                {sortedArchiveMatches.length > 0 && (
                  <div className="match-section">
                    <h4 className="match-section-title archive-title">Совпадения с архивом «Память народа»</h4>
                    {sortedArchiveMatches.map((match, index) => {
                      const archivePerson = match.person;
                      const isExpanded = expandedArchive === index;

                      return (
                        <div key={`archive-${index}`} className="match-card archive-match-card">
                          <div className="match-comparison">
                            <div className="match-person current-person">
                              <h4 className="match-person-title">Ваше дерево</h4>
                              <div className="match-person-info">
                                <p className="match-name">{getFullName(person)}</p>
                                <p className="match-detail">
                                  <Calendar size={14} />
                                  {formatDate(person.birthDate)}
                                </p>
                                <p className="match-detail">
                                  <MapPin size={14} />
                                  {person.birthPlace || 'Не указано'}
                                </p>
                              </div>
                            </div>

                            <div className="match-arrow archive-arrow">
                              <FourPointStar size={18} />
                            </div>

                            <div className="match-person found-person archive-person">
                              <h4 className="match-person-title">Архив «Память народа»</h4>
                              <div className="match-person-info">
                                <p className="match-name">{archivePerson ? getFullName(archivePerson) : 'Неизвестно'}</p>
                                <p className="match-detail">
                                  <Calendar size={14} />
                                  {formatDate(archivePerson?.birthDate)}
                                </p>
                                <p className="match-detail">
                                  <MapPin size={14} />
                                  {archivePerson?.birthPlace || 'Не указано'}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="match-score archive-score">
                            <span className="score-label">Вероятность совпадения:</span>
                            <span className="score-value">{match.score?.toFixed(1)}%</span>
                          </div>

                          {archivePerson?.information && (
                            <div className="match-relatives-section">
                              <button 
                                className="match-relatives-toggle"
                                onClick={() => toggleArchiveExpand(index)}
                              >
                                <FileText size={16} />
                                <span>Информация из архива</span>
                                <ChevronRight 
                                  size={16} 
                                  className={`toggle-icon ${isExpanded ? 'expanded' : ''}`}
                                />
                              </button>
                              
                              {isExpanded && (
                                <div className="match-archive-info">
                                  <p className="archive-description">{archivePerson.information}</p>
                                </div>
                              )}
                            </div>
                          )}

                          <button 
                            className="btn btn-primary match-confirm-btn archive-confirm-btn"
                            onClick={() => onConfirmArchive(match)}
                          >
                            <Check size={16} />
                            Подтвердить совпадение
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {showPaymentModal && <PaymentModal />}
      {showConfirmPurchaseModal && <ConfirmPurchaseModal />}
      {showRequestModal && <RequestModal />}
    </>
  );
};

// ============================================
// MAIN APP COMPONENT
// ============================================

function App() {
  const [people, setPeople] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('tree');
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showAddRelativeModal, setShowAddRelativeModal] = useState(false);
  const [availableRelations, setAvailableRelations] = useState([]);
  const [initialRelation, setInitialRelation] = useState(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [matchPerson, setMatchPerson] = useState(null);
  const [treeMatches, setTreeMatches] = useState([]);
  const [archiveMatches, setArchiveMatches] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [smartMatchBalance, setSmartMatchBalance] = useState(0);
  const [grantedAccessIds, setGrantedAccessIds] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showBalancePanel, setShowBalancePanel] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [isAdminAuthorized, setIsAdminAuthorized] = useState(false);
  const [adminLogin, setAdminLogin] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminSourcePreferences, setAdminSourcePreferences] = useState(DEFAULT_ADMIN_SOURCE_PREFERENCES);
  const [adminScoreThresholds, setAdminScoreThresholds] = useState(DEFAULT_ADMIN_SCORE_THRESHOLDS);
  const [isAdminSaving, setIsAdminSaving] = useState(false);
  // Use refs for matches to ensure synchronous access
  const allTreeMatchesRef = useRef([]);
  const allArchiveMatchesRef = useRef([]);
  const uploadInputRef = useRef(null);
  const [expandedSiblingGroups, setExpandedSiblingGroups] = useState({});
  const [showSmartMatchingTutorial, setShowSmartMatchingTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(1);
  const [smartSearchQuery, setSmartSearchQuery] = useState('');
  const [smartSearchFocusedPersonId, setSmartSearchFocusedPersonId] = useState(null);
  const [unlockedSmartSearchArchiveKeys, setUnlockedSmartSearchArchiveKeys] = useState([]);
  const [showSmartSearchPaymentModal, setShowSmartSearchPaymentModal] = useState(false);
  const [showSmartSearchConfirmModal, setShowSmartSearchConfirmModal] = useState(false);
  const [showSmartSearchRequestModal, setShowSmartSearchRequestModal] = useState(false);
  const [smartSearchActionContext, setSmartSearchActionContext] = useState(null);
  const [smartSearchRequestMessage, setSmartSearchRequestMessage] = useState('');
  const [isSmartSearchActionProcessing, setIsSmartSearchActionProcessing] = useState(false);
  const [showSmartSearchPaymentSuccess, setShowSmartSearchPaymentSuccess] = useState(false);
  const [smartSearchSelectedPlan, setSmartSearchSelectedPlan] = useState('basic');
  const [smartSearchBasicQuantity, setSmartSearchBasicQuantity] = useState(1);
  const [rejectedSmartSearchEntries, setRejectedSmartSearchEntries] = useState([]);
  const [smartSearchMatchTab, setSmartSearchMatchTab] = useState('all');
  const [smartSearchViewMode, setSmartSearchViewMode] = useState('list');
  const [smartSearchExploringPersonId, setSmartSearchExploringPersonId] = useState(null);
  const [studiedSmartSearchEntryKeys, setStudiedSmartSearchEntryKeys] = useState(() => {
    try {
      const storedKeys = JSON.parse(localStorage.getItem(SMART_SEARCH_STUDIED_STORAGE_KEY) || '[]');
      return Array.isArray(storedKeys) ? storedKeys.map(String) : [];
    } catch (error) {
      console.error('Failed to read studied smart search cards:', error);
      return [];
    }
  });
  const [smartSearchStatus, setSmartSearchStatus] = useState({
    running: false,
    totalSteps: 0,
    completedSteps: 0,
    currentSource: null
  });

  // Show notification as long as there are any unconfirmed matches (people with hasMatch = true)
  const showMatchFoundNotification = useMemo(() => {
    return activeSection === 'tree' && Object.values(people).some(person => person.hasMatch);
  }, [people, activeSection]);

  const focalPersonId = useMemo(
    () => pickFocalPersonId(people, selectedPerson?.id),
    [people, selectedPerson]
  );

  const treeView = useMemo(
    () => buildTreeView(people, focalPersonId, expandedSiblingGroups),
    [people, focalPersonId, expandedSiblingGroups]
  );

  const smartSearchPeople = useMemo(() => {
    return Object.values(people)
      .sort((a, b) => getFullName(a).localeCompare(getFullName(b), 'ru'));
  }, [people]);

  const smartSearchPeopleWithStatus = useMemo(() => (
    smartSearchPeople.map((person) => {
      const isReady = isReadyForSmartSearch(person, DEFAULT_SMART_SEARCH_CRITERIA);
      const sourceRecords = SMART_SEARCH_SUPPORTED_SOURCE_KEYS.flatMap((sourceKey) =>
        getSourceRecords(person, sourceKey)
      );
      const hasMatches = sourceRecords.length > 0;
      const hasSourceCache = SMART_SEARCH_SUPPORTED_SOURCE_KEYS.some((sourceKey) => {
        const sourceCache = person.sourceSearchCache?.[sourceKey];
        return sourceCache && Array.isArray(sourceCache.matches);
      });
      const statusLabel = hasMatches
        ? 'Найдено совпадение'
        : hasSourceCache
          ? 'Совпадений не найдено'
          : isReady
            ? 'Готово к поиску'
            : 'Недостаточно данных';
      const statusClass = hasMatches
        ? 'found'
        : hasSourceCache
          ? 'empty'
          : isReady
            ? 'ready'
            : 'pending';
      return {
        person,
        sourceRecords,
        hasMatches,
        hasSourceCache,
        statusLabel,
        statusClass
      };
    })
  ), [smartSearchPeople]);

  const smartSearchEntries = useMemo(() => {
    const entries = [];
    const treeGroups = new Map();
    smartSearchPeopleWithStatus.forEach((card) => {
      if (!card.hasMatches) return;
      const treeRecords = card.sourceRecords.filter((record) => isUserTreeRecord(record));
      const archiveRecords = card.sourceRecords.filter((record) => isArchiveRecord(record));
      treeRecords.forEach((record) => {
        const treeId = String(record.tree_id || '');
        if (!treeId) return;
        if (!treeGroups.has(treeId)) {
          treeGroups.set(treeId, {
            id: `tree:${treeId}`,
            sourceType: 'tree',
            tree_id: treeId,
            treeOwner: record.tree_owner || 'Владелец дерева',
            pairsByPersonId: new Map()
          });
        }
        const group = treeGroups.get(treeId);
        const personId = String(card.person.id);
        const currentPair = group.pairsByPersonId.get(personId);
        if (!currentPair || Number(record.score || 0) > Number(currentPair.record.score || 0)) {
          group.pairsByPersonId.set(personId, {
            person: card.person,
            record
          });
        }
      });
      if (archiveRecords.length > 0) {
        entries.push({
          id: `${card.person.id}:archive`,
          person: card.person,
          sourceType: 'archive',
          sourceRecords: archiveRecords
        });
      }
    });
    const treeEntries = Array.from(treeGroups.values()).map((group) => {
      const pairs = Array.from(group.pairsByPersonId.values())
        .sort((a, b) => getFullName(a.person).localeCompare(getFullName(b.person), 'ru'));
      const mergedRecord = pairs
        .map((pair) => pair.record)
        .find((record) => record.treeMergeStatus === 'merged' && record.treeMergeOperationId);
      return {
        id: group.id,
        person: pairs[0]?.person || null,
        sourceType: 'tree',
        tree_id: group.tree_id,
        treeOwner: group.treeOwner,
        pairs,
        sourceRecords: pairs.map((pair) => pair.record),
        relatedPersonIds: pairs.map((pair) => String(pair.person.id)),
        isMerged: Boolean(mergedRecord),
        mergeOperationId: mergedRecord?.treeMergeOperationId || '',
        addedCount: Number(mergedRecord?.treeMergeAddedCount) || 0
      };
    });
    return [...treeEntries, ...entries];
  }, [smartSearchPeopleWithStatus]);

  const rejectedSmartSearchEntryIds = useMemo(
    () => new Set(rejectedSmartSearchEntries.map((entry) => entry.id)),
    [rejectedSmartSearchEntries]
  );
  const smartSearchRejectedEntries = useMemo(
    () => smartSearchEntries.filter((entry) => rejectedSmartSearchEntryIds.has(entry.id)),
    [smartSearchEntries, rejectedSmartSearchEntryIds]
  );
  const smartSearchActiveEntries = useMemo(
    () => smartSearchEntries.filter((entry) => !rejectedSmartSearchEntryIds.has(entry.id)),
    [smartSearchEntries, rejectedSmartSearchEntryIds]
  );
  const smartSearchTreeEntries = useMemo(
    () => smartSearchActiveEntries.filter((entry) => entry.sourceType === 'tree'),
    [smartSearchActiveEntries]
  );
  const smartSearchArchiveEntries = useMemo(
    () => smartSearchActiveEntries.filter((entry) => entry.sourceType === 'archive'),
    [smartSearchActiveEntries]
  );
  const smartSearchTabCounts = useMemo(() => ({
    all: smartSearchActiveEntries.length,
    found: smartSearchActiveEntries.length,
    tree: smartSearchTreeEntries.length,
    archive: smartSearchArchiveEntries.length,
    rejected: smartSearchRejectedEntries.length
  }), [
    smartSearchActiveEntries.length,
    smartSearchTreeEntries.length,
    smartSearchArchiveEntries.length,
    smartSearchRejectedEntries.length
  ]);
  const smartSearchExploreEntry = useMemo(
    () => smartSearchEntries.find((entry) => entry.id === smartSearchExploringPersonId) || null,
    [smartSearchEntries, smartSearchExploringPersonId]
  );
  const isSmartSearchExploreTree = smartSearchExploreEntry?.sourceType === 'tree';
  const smartSearchExplorePerson = smartSearchExploreEntry?.person || null;
  const smartSearchExplorePairs = smartSearchExploreEntry?.pairs || [];
  const smartSearchExploreSourceRecords = smartSearchExploreEntry?.sourceRecords || [];
  const isSmartSearchExploreRejected = Boolean(
    smartSearchExploreEntry && rejectedSmartSearchEntryIds.has(smartSearchExploreEntry.id)
  );
  const smartSearchExploreTreeRecords = useMemo(
    () => smartSearchExploreSourceRecords.filter((record) => isUserTreeRecord(record)),
    [smartSearchExploreSourceRecords]
  );
  const smartSearchExploreArchiveRecords = useMemo(
    () => smartSearchExploreSourceRecords.filter((record) => isArchiveRecord(record)),
    [smartSearchExploreSourceRecords]
  );
  const smartSearchExploreRecords = useMemo(
    () => [...smartSearchExploreTreeRecords, ...smartSearchExploreArchiveRecords],
    [smartSearchExploreTreeRecords, smartSearchExploreArchiveRecords]
  );
  const smartSearchExploreLockedTreeRecords = useMemo(
    () => smartSearchExploreTreeRecords.filter((record) => !isSmartSearchRecordUnlocked(record)),
    [smartSearchExploreTreeRecords, grantedAccessIds]
  );
  const smartSearchExploreLockedArchiveRecords = useMemo(
    () => smartSearchExploreArchiveRecords.filter((record) => !isSmartSearchRecordUnlocked(record)),
    [smartSearchExploreArchiveRecords, unlockedSmartSearchArchiveKeys]
  );
  const smartSearchExploreHasLockedRecords = smartSearchExploreLockedTreeRecords.length > 0 || smartSearchExploreLockedArchiveRecords.length > 0;

  const handleZoomIn = () => {
    setZoom(prev => Math.min(prev + 0.1, 2));
  };

  const handleZoomOut = () => {
    setZoom(prev => Math.max(prev - 0.1, 0.3));
  };

  const handleCenterTree = () => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  };

  const handleToggleGroup = (groupKey) => {
    setExpandedSiblingGroups(prev => ({
      ...prev,
      [groupKey]: !prev[groupKey]
    }));
  };

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('Некорректный формат');
      }

      const response = await fetch(`${API_URL}/database/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: parsed })
      });

      if (!response.ok) {
        throw new Error('Ошибка загрузки на сервер');
      }

      const data = await response.json();
      const nextPeople = data.people || {};

      setStudiedSmartSearchEntryKeys([]);
      try {
        localStorage.removeItem(SMART_SEARCH_STUDIED_STORAGE_KEY);
      } catch (storageError) {
        console.error('Failed to reset studied smart search cards:', storageError);
      }
      setSmartSearchViewMode('list');
      setSmartSearchExploringPersonId(null);
      setSmartSearchFocusedPersonId(null);
      setSmartSearchQuery('');
      setPeople(nextPeople);
      setExpandedSiblingGroups({});
      setSelectedPerson(null);
      setShowMatchModal(false);
      setMatchPerson(null);
      setTreeMatches([]);
      setArchiveMatches([]);
      allTreeMatchesRef.current = [];
      allArchiveMatchesRef.current = [];
      showToast('Новый JSON загружен, прежние данные заменены');

      // Poll briefly to pick up deferred auto-search results without page refresh.
      const pollAttempts = 6;
      const pollDelayMs = 900;
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        try {
          const pollResponse = await fetch(`${API_URL}/people`);
          if (!pollResponse.ok) continue;
          const polledPeople = await pollResponse.json();
          const hasNewMatches = Object.values(polledPeople).some((person) => person?.hasMatch);
          if (hasNewMatches) {
            setPeople(polledPeople);
            break;
          }
          if (attempt === pollAttempts - 1) {
            setPeople(polledPeople);
          }
        } catch (pollError) {
          console.error('Deferred smart-search polling error:', pollError);
        }
      }
    } catch (error) {
      console.error('Upload error:', error);
      showToast('Ошибка загрузки JSON', 'error');
    } finally {
      event.target.value = '';
    }
  };

  const handleDownload = async () => {
    try {
      const response = await fetch(`${API_URL}/database/export`);
      if (!response.ok) {
        throw new Error('Ошибка выгрузки');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'database.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download error:', error);
      showToast('Ошибка скачивания JSON', 'error');
    }
  };

  const handleAddBalance = (amount) => {
    setSmartMatchBalance(prev => prev + amount);
    showToast(`Баланс пополнен на ${amount} совпадений`);
  };

  const handleSpendBalance = (amount) => {
    setSmartMatchBalance(prev => Math.max(0, prev - amount));
  };

  const handleGrantAccess = (treeId) => {
    setGrantedAccessIds(prev => [...prev, treeId]);
    showToast('Доступ к дереву получен');
  };

  const handleMatchNotificationClick = () => {
    setTutorialStep(1);
    setShowSmartMatchingTutorial(true);
  };

  const openSmartSearchForPerson = (person) => {
    if (!person) return;
    setSmartSearchFocusedPersonId(person.id);
    setSmartSearchMatchTab('all');
    setSmartSearchQuery(getFullName(person));
    setSmartSearchViewMode('list');
    setSmartSearchExploringPersonId(null);
    setActiveSection('smart-search');
  };

  const openSmartSearchSection = () => {
    setSmartSearchFocusedPersonId(null);
    setSmartSearchMatchTab('all');
    setSmartSearchViewMode('list');
    setSmartSearchExploringPersonId(null);
    setActiveSection('smart-search');
  };

  const handleTutorialNext = () => {
    if (tutorialStep < 3) {
      setTutorialStep(prev => prev + 1);
    } else {
      setShowSmartMatchingTutorial(false);
      setTutorialStep(1);
      openSmartSearchSection();
    }
  };

  const handleTutorialClose = () => {
    setShowSmartMatchingTutorial(false);
    setTutorialStep(1);
  };

  const getSmartSearchCardsByTab = useCallback((tabKey) => {
    const applyFocus = (entries) => (
      smartSearchFocusedPersonId
        ? entries.filter((entry) => (
          String(entry.person?.id) === String(smartSearchFocusedPersonId)
          || entry.relatedPersonIds?.includes(String(smartSearchFocusedPersonId))
        ))
        : entries
    );
    switch (tabKey) {
      case 'found':
        return applyFocus(smartSearchActiveEntries);
      case 'tree':
        return applyFocus(smartSearchTreeEntries);
      case 'archive':
        return applyFocus(smartSearchArchiveEntries);
      case 'rejected':
        return applyFocus(smartSearchRejectedEntries);
      case 'all':
      default:
        return applyFocus(smartSearchActiveEntries);
    }
  }, [
    smartSearchFocusedPersonId,
    smartSearchActiveEntries,
    smartSearchTreeEntries,
    smartSearchArchiveEntries,
    smartSearchRejectedEntries
  ]);

  const handleSmartSearchTabChange = (tabKey) => {
    setSmartSearchMatchTab(tabKey);
    setSmartSearchFocusedPersonId(null);
  };

  const markSmartSearchEntryStudied = useCallback((entry) => {
    if (!entry) return;
    const studyKey = getSmartSearchEntryStudyKey(entry);
    setStudiedSmartSearchEntryKeys((prev) => (
      prev.includes(studyKey)
        ? prev
        : [...prev, studyKey]
    ));
  }, []);

  const handleEnterSmartSearchExplore = (entry) => {
    if (!entry) return;
    markSmartSearchEntryStudied(entry);
    setSmartSearchExploringPersonId(entry.id);
    setSmartSearchViewMode('explore');
  };

  const handleExitSmartSearchExplore = () => {
    setSmartSearchViewMode('list');
    setSmartSearchExploringPersonId(null);
  };

  const handleRejectSmartSearchCard = (entry) => {
    if (!entry) return;
    setRejectedSmartSearchEntries((prev) => (
      prev.some((item) => item.id === entry.id)
        ? prev
        : [...prev, entry]
    ));
    handleExitSmartSearchExplore();
  };

  const handleRestoreSmartSearchCard = (entry) => {
    if (!entry) return;
    setRejectedSmartSearchEntries((prev) => prev.filter((item) => item.id !== entry.id));
    handleExitSmartSearchExplore();
  };

  const visibleSmartSearchListCards = useMemo(
    () => getSmartSearchCardsByTab(smartSearchMatchTab)
      .filter((entry) => {
        const query = normalizeSearchValue(smartSearchQuery);
        if (!query) return true;
        const entryText = entry.sourceType === 'tree'
          ? [
            entry.treeOwner,
            getTreeEntryTitle(entry),
            ...(entry.pairs || []).map((pair) => getFullName(pair.person))
          ].join(' ')
          : getFullName(entry.person);
        return normalizeSearchValue(entryText).includes(query);
      }),
    [getSmartSearchCardsByTab, smartSearchMatchTab, smartSearchQuery]
  );

  function isSmartSearchRecordUnlocked(record) {
    const recordKey = getDocumentKey(record);
    if (!recordKey) return false;
    if (isUserTreeRecord(record)) {
      return Boolean(record.tree_id && grantedAccessIds.includes(record.tree_id));
    }
    if (isArchiveRecord(record)) {
      return unlockedSmartSearchArchiveKeys.includes(recordKey);
    }
    return true;
  }

  const resetSmartSearchActionState = () => {
    setShowSmartSearchPaymentModal(false);
    setShowSmartSearchConfirmModal(false);
    setShowSmartSearchRequestModal(false);
    setSmartSearchActionContext(null);
    setSmartSearchRequestMessage('');
    setIsSmartSearchActionProcessing(false);
    setShowSmartSearchPaymentSuccess(false);
  };

  const startSmartSearchCardPurchase = (person, lockedTreeRecords, lockedArchiveRecords) => {
    if (!lockedTreeRecords.length && !lockedArchiveRecords.length) return;
    const treeMap = new Map();
    lockedTreeRecords.forEach((record) => {
      if (!record.tree_id) return;
      if (!treeMap.has(record.tree_id)) {
        treeMap.set(record.tree_id, record.tree_owner || 'Владелец дерева');
      }
    });
    const treeIds = Array.from(treeMap.keys());
    const archiveRecordKeys = Array.from(new Set(
      lockedArchiveRecords
        .map((record) => getDocumentKey(record))
        .filter(Boolean)
    ));
    const requiredMatches = 1;
    const owners = Array.from(treeMap.values());

    setSmartSearchActionContext({
      type: treeIds.length ? 'treeMerge' : 'cardPurchase',
      personId: person.id,
      personName: getFullName(person),
      requiredMatches,
      treeIds,
      archiveRecordKeys,
      treeOwners: owners
    });
    if (smartMatchBalance >= requiredMatches) {
      setShowSmartSearchConfirmModal(true);
      return;
    }
    setSmartSearchBasicQuantity(requiredMatches);
    setSmartSearchSelectedPlan('basic');
    setShowSmartSearchPaymentModal(true);
  };

  const handleSmartSearchConfirmPurchase = () => {
    setShowSmartSearchConfirmModal(false);
    if (!smartSearchActionContext) return;
    handleSpendBalance(1);
    if (!smartSearchActionContext.treeIds?.length) {
      setUnlockedSmartSearchArchiveKeys((prev) => Array.from(new Set([
        ...prev,
        ...(smartSearchActionContext.archiveRecordKeys || [])
      ])));
      showToast('Карточка разблокирована');
      setSmartSearchActionContext(null);
      return;
    }
    const firstOwner = smartSearchActionContext.treeOwners?.[0] || 'владельцу дерева';
    setSmartSearchRequestMessage(`Здравствуйте, ${firstOwner}! Я хотел бы объединить наши семейные древа.`);
    setShowSmartSearchRequestModal(true);
  };

  const handleSmartSearchBuyMatches = async () => {
    setIsSmartSearchActionProcessing(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    setIsSmartSearchActionProcessing(false);
    setShowSmartSearchPaymentSuccess(true);

    const matchesToAdd = smartSearchSelectedPlan === 'package' ? 10 : smartSearchBasicQuantity;
    await new Promise(resolve => setTimeout(resolve, 1500));
    setShowSmartSearchPaymentSuccess(false);
    setShowSmartSearchPaymentModal(false);
    handleAddBalance(matchesToAdd);

    if (smartSearchActionContext) {
      setShowSmartSearchConfirmModal(true);
    }
  };

  const handleSmartSearchSendRequest = async () => {
    if (!smartSearchActionContext?.treeIds?.length) return;
    setIsSmartSearchActionProcessing(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    setIsSmartSearchActionProcessing(false);

    setGrantedAccessIds((prev) => Array.from(new Set([
      ...prev,
      ...smartSearchActionContext.treeIds
    ])));
    setUnlockedSmartSearchArchiveKeys((prev) => Array.from(new Set([
      ...prev,
      ...(smartSearchActionContext.archiveRecordKeys || [])
    ])));
    setShowSmartSearchRequestModal(false);
    setSmartSearchActionContext(null);
    setSmartSearchRequestMessage('');
    showToast('Доступ к древу получен');
  };

  const handleMergeSmartSearchTree = async (entry) => {
    if (!entry?.tree_id || !Array.isArray(entry.pairs) || entry.pairs.length === 0) return;
    setIsSmartSearchActionProcessing(true);
    try {
      const response = await fetch(`${API_URL}/trees/${encodeURIComponent(entry.tree_id)}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matches: entry.pairs.map(({ person, record }) => ({
            data_id: person.id,
            database_id: record.database_id
          }))
        })
      });
      if (!response.ok) {
        throw new Error('Не удалось объединить деревья');
      }
      const result = await response.json();
      setPeople(result.people || {});
      showToast(
        result.addedCount > 0
          ? `Деревья объединены, добавлено родственников: ${result.addedCount}`
          : 'Деревья уже объединены'
      );
    } catch (error) {
      console.error('Tree merge error:', error);
      showToast('Ошибка объединения деревьев', 'error');
    } finally {
      setIsSmartSearchActionProcessing(false);
    }
  };

  const handleUndoSmartSearchTreeMerge = async (entry) => {
    if (!entry?.mergeOperationId) return;
    setIsSmartSearchActionProcessing(true);
    try {
      const response = await fetch(`${API_URL}/tree-merges/${encodeURIComponent(entry.mergeOperationId)}/undo`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error('Не удалось отменить объединение деревьев');
      }
      const result = await response.json();
      setPeople(result.people || {});
      showToast('Объединение деревьев отменено');
    } catch (error) {
      console.error('Tree merge undo error:', error);
      showToast('Ошибка отмены объединения деревьев', 'error');
    } finally {
      setIsSmartSearchActionProcessing(false);
    }
  };

  const savePersonDocuments = async (personId, documents, successMessage) => {
    const response = await fetch(`${API_URL}/people/${personId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents })
    });
    if (!response.ok) {
      throw new Error('Не удалось сохранить документы');
    }
    const updatedPerson = await response.json();
    setPeople((prev) => ({
      ...prev,
      [updatedPerson.id]: updatedPerson
    }));
    setSelectedPerson((prev) => (prev?.id === updatedPerson.id ? updatedPerson : prev));
    if (successMessage) {
      showToast(successMessage);
    }
    return updatedPerson;
  };

  const handleAddAllUnlockedDocumentsForPerson = async (person, sourceRecords) => {
    const unlockedRecords = sourceRecords.filter((record) => isSmartSearchRecordUnlocked(record));
    if (!unlockedRecords.length) {
      showToast('Данные пока недоступны', 'error');
      return;
    }
    const existingDocuments = Array.isArray(person.documents) ? person.documents : [];
    const mergedMap = new Map();
    existingDocuments.forEach((document) => {
      const key = getDocumentKey(document);
      if (!key) return;
      mergedMap.set(key, normalizeDocumentRecord(document));
    });
    unlockedRecords.forEach((record) => {
      const normalized = normalizeDocumentRecord(record);
      const key = getDocumentKey(normalized);
      if (!key) return;
      mergedMap.set(key, normalized);
    });
    const nextDocuments = Array.from(mergedMap.values());
    try {
      await savePersonDocuments(person.id, nextDocuments, 'Документы добавлены в карточку');
    } catch (error) {
      console.error('Error adding unlocked documents:', error);
      showToast('Ошибка добавления документов', 'error');
    }
  };

  const handleRemoveDocumentFromPersonCard = async (person, document, index) => {
    const targetKey = `${getDocumentKey(document)}-${index}`;
    const currentDocuments = Array.isArray(person.documents) ? person.documents : [];
    const nextDocuments = currentDocuments.filter((item, itemIndex) => (
      `${getDocumentKey(item)}-${itemIndex}` !== targetKey
    ));
    try {
      await savePersonDocuments(person.id, nextDocuments, 'Документ возвращен в ожидающие подтверждения');
    } catch (error) {
      console.error('Error removing document:', error);
      showToast('Ошибка удаления документа', 'error');
    }
  };

  const sidebarNav = [
    { key: 'home', label: 'Главная', icon: Home },
    { key: 'health', label: 'Здоровье', icon: HeartPulse },
    { key: 'recommendations', label: 'Рекомендации', icon: ThumbsUp },
    { key: 'medcard', label: 'Медицинская карта', icon: FileText },
    { key: 'survey', label: 'Анкета', icon: ClipboardList },
    { key: 'origin', label: 'Происхождение', icon: Globe2 },
    { key: 'tree', label: 'Генеалогическое древо', icon: GitBranch },
    { key: 'smart-search', label: 'Умный поиск', icon: FourPointStar },
    { key: 'services', label: 'Генеалогические услуги', icon: Briefcase },
    { key: 'pregnancy', label: 'Планирование беременности', icon: Baby }
  ];

  // Fetch people data
  const fetchPeople = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/people`);
      const data = await response.json();
      setPeople(data);
    } catch (error) {
      console.error('Error fetching people:', error);
      showToast('Ошибка загрузки данных', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPeople();
  }, [fetchPeople]);

  useEffect(() => {
    let isMounted = true;
    let timerId = null;
    let lastFinishedAt = null;

    const pollSmartSearchStatus = async () => {
      try {
        const response = await fetch(`${API_URL}/smart-matching/status`);
        if (!response.ok) return;
        const status = await response.json();
        if (!isMounted) return;

        setSmartSearchStatus({
          running: Boolean(status?.running),
          totalSteps: Number(status?.totalSteps) || 0,
          completedSteps: Number(status?.completedSteps) || 0,
          currentSource: status?.currentSource || null
        });

        if (status?.running === false && status?.finishedAt && status.finishedAt !== lastFinishedAt) {
          lastFinishedAt = status.finishedAt;
          await fetchPeople();
        }
      } catch (error) {
        console.error('Smart-search status polling error:', error);
      } finally {
        if (isMounted) {
          timerId = setTimeout(pollSmartSearchStatus, 1200);
        }
      }
    };

    pollSmartSearchStatus();

    return () => {
      isMounted = false;
      if (timerId) clearTimeout(timerId);
    };
  }, [fetchPeople]);

  // Toast helper - also adds to notifications
  const showToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    // Add to notifications (only for success messages)
    if (type === 'success') {
      setNotifications(prev => [
        { id, message, timestamp: new Date(), type },
        ...prev
      ]);
    }
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const clearNotifications = () => {
    setNotifications([]);
  };

  // Handle person selection
  const handleSelectPerson = (person) => {
    setSelectedPerson(person);
  };

  // Handle edit
  const handleEdit = () => {
    setShowEditModal(true);
  };

  const handleSaveEdit = async (formData) => {
    try {
      const response = await fetch(`${API_URL}/people/${selectedPerson.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      
      if (response.ok) {
        const updatedPerson = await response.json();
        setPeople(prev => ({
          ...prev,
          [updatedPerson.id]: updatedPerson
        }));
        setSelectedPerson(updatedPerson);
        setShowEditModal(false);
        showToast('Изменения сохранены');
      }
    } catch (error) {
      console.error('Error updating person:', error);
      showToast('Ошибка сохранения', 'error');
    }
  };

  // Handle add relative
  const handleAddRelative = (relation) => {
    setAvailableRelations([relation]);
    setInitialRelation(relation);
    setShowAddRelativeModal(true);
  };

  const handleSaveRelative = async (relationType, relativeData) => {
    try {
      const response = await fetch(`${API_URL}/people/${selectedPerson.id}/relative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationType, relativeData })
      });
      
      if (response.ok) {
        await fetchPeople();
        setShowAddRelativeModal(false);
        showToast('Родственник добавлен');
      }
    } catch (error) {
      console.error('Error adding relative:', error);
      showToast('Ошибка добавления', 'error');
    }
  };

  // Handle delete
  const handleDelete = () => {
    setShowConfirmDelete(true);
  };

  const handleConfirmDelete = async () => {
    try {
      const response = await fetch(`${API_URL}/people/${selectedPerson.id}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        await fetchPeople();
        setSelectedPerson(null);
        setShowConfirmDelete(false);
        showToast('Запись удалена');
      }
    } catch (error) {
      console.error('Error deleting person:', error);
      showToast('Ошибка удаления', 'error');
    }
  };

  // Handle adding new root person
  const handleAddNewPerson = async () => {
    try {
      const response = await fetch(`${API_URL}/people`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Новый',
          lastName: 'Человек',
          gender: 'male'
        })
      });
      
      if (response.ok) {
        const newPerson = await response.json();
        await fetchPeople();
        setSelectedPerson(newPerson);
        showToast('Человек добавлен');
      }
    } catch (error) {
      console.error('Error adding person:', error);
      showToast('Ошибка добавления', 'error');
    }
  };

  // Run source search for selected people
  // Handle match icon click - open Smart Search filtered by person
  const handleMatchClick = (person) => {
    openSmartSearchForPerson(person);
  };

  const handleProfileClick = () => {
    setShowAdminPanel((prev) => !prev);
    setShowNotifications(false);
    setShowBalancePanel(false);
  };

  const handleAdminLogin = async () => {
    try {
      const response = await fetch(`${API_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: adminLogin,
          password: adminPassword
        })
      });
      if (!response.ok) {
        showToast('Неверный логин или пароль', 'error');
        return;
      }
      const data = await response.json();
      setIsAdminAuthorized(true);
      setAdminSourcePreferences(data.sourcePreferences || DEFAULT_ADMIN_SOURCE_PREFERENCES);
      setAdminScoreThresholds(data.scoreThresholds || DEFAULT_ADMIN_SCORE_THRESHOLDS);
      showToast('Режим администратора открыт');
    } catch (error) {
      console.error('Admin login error:', error);
      showToast('Ошибка входа', 'error');
    }
  };

  const handleAdminSourceToggle = (sourceKey) => {
    setAdminSourcePreferences((prev) => ({
      ...prev,
      [sourceKey]: !prev[sourceKey]
    }));
  };

  const handleAdminThresholdChange = (thresholdKey, value) => {
    setAdminScoreThresholds((prev) => ({
      ...prev,
      [thresholdKey]: value === '' ? '' : Math.min(100, Math.max(0, Number(value)))
    }));
  };

  const handleAdminSave = async () => {
    setIsAdminSaving(true);
    try {
      const response = await fetch(`${API_URL}/admin/source-preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: adminLogin,
          password: adminPassword,
          sourcePreferences: adminSourcePreferences,
          scoreThresholds: adminScoreThresholds
        })
      });
      if (!response.ok) {
        showToast('Не удалось сохранить настройки', 'error');
        return;
      }
      const data = await response.json();
      setAdminSourcePreferences(data.sourcePreferences || DEFAULT_ADMIN_SOURCE_PREFERENCES);
      setAdminScoreThresholds(data.scoreThresholds || DEFAULT_ADMIN_SCORE_THRESHOLDS);
      await fetchPeople();
      showToast('Настройки источников сохранены');
    } catch (error) {
      console.error('Admin save settings error:', error);
      showToast('Ошибка сохранения настроек', 'error');
    } finally {
      setIsAdminSaving(false);
    }
  };

  // Handle tree match confirmation
  const handleConfirmTreeMatch = async (match) => {
    try {
      const response = await fetch(`${API_URL}/people/${matchPerson.id}/confirm-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match })
      });
      
      if (response.ok) {
        await fetchPeople();
        setShowMatchModal(false);
        setMatchPerson(null);
        setTreeMatches([]);
        setArchiveMatches([]);
        showToast('Совпадение подтверждено, родственники добавлены');
      }
    } catch (error) {
      console.error('Error confirming match:', error);
      showToast('Ошибка подтверждения', 'error');
    }
  };

  // Handle archive match confirmation
  const handleConfirmArchiveMatch = async (match) => {
    try {
      const response = await fetch(`${API_URL}/people/${matchPerson.id}/confirm-archive-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match })
      });
      
      if (response.ok) {
        const data = await response.json();
        await fetchPeople();
        // Update selected person if it's the same
        if (selectedPerson?.id === matchPerson.id) {
          setSelectedPerson(data.person);
        }
        setShowMatchModal(false);
        setMatchPerson(null);
        setTreeMatches([]);
        setArchiveMatches([]);
        showToast('Информация из архива добавлена');
      }
    } catch (error) {
      console.error('Error confirming archive match:', error);
      showToast('Ошибка подтверждения', 'error');
    }
  };

  // Close notifications/balance panel when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showNotifications && !e.target.closest('.notifications-wrapper')) {
        setShowNotifications(false);
      }
      if (showBalancePanel && !e.target.closest('.balance-wrapper') && !e.target.closest('.payment-modal')) {
        setShowBalancePanel(false);
      }
      if (showAdminPanel && !e.target.closest('.admin-wrapper')) {
        setShowAdminPanel(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showNotifications, showBalancePanel, showAdminPanel]);

  useEffect(() => {
    setShowNotifications(false);
    setShowBalancePanel(false);
    setShowAdminPanel(false);
  }, [activeSection]);

  useEffect(() => {
    try {
      localStorage.setItem(
        SMART_SEARCH_STUDIED_STORAGE_KEY,
        JSON.stringify(studiedSmartSearchEntryKeys)
      );
    } catch (error) {
      console.error('Failed to save studied smart search cards:', error);
    }
  }, [studiedSmartSearchEntryKeys]);

  useEffect(() => {
    if (smartSearchViewMode === 'explore' && smartSearchExploreEntry) {
      markSmartSearchEntryStudied(smartSearchExploreEntry);
    }
  }, [markSmartSearchEntryStudied, smartSearchExploreEntry, smartSearchViewMode]);

  const smartSearchRequiredMatches = smartSearchActionContext?.requiredMatches || 1;
  const smartSearchPaymentBasicPrice = 199;
  const smartSearchPaymentPackagePrice = 1790;
  const smartSearchPaymentBasicTotal = smartSearchBasicQuantity * smartSearchPaymentBasicPrice;
  const smartSearchActionTitle = smartSearchActionContext?.type === 'treeMerge'
    ? 'объединения деревьев'
    : 'разблокировки карточки';
  const smartSearchPurchaseTitle = smartSearchActionContext?.type === 'treeMerge'
    ? 'объединение деревьев'
    : 'разблокировку карточки';
  const smartSearchProgressPercent = useMemo(() => {
    if (!smartSearchStatus.running || !smartSearchStatus.totalSteps) return 0;
    return Math.min(100, Math.round((smartSearchStatus.completedSteps / smartSearchStatus.totalSteps) * 100));
  }, [smartSearchStatus]);

  if (loading) {
    return (
      <div className="app">
        <div className="loading">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">Genotek</div>
        <nav className="sidebar-nav">
          {sidebarNav.map(item => {
            const Icon = item.icon;
            const isActive = item.key === activeSection;
            return (
              <button 
                key={item.key}
                type="button"
                className={`nav-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (item.key === 'smart-search') {
                    openSmartSearchSection();
                    return;
                  }
                  setActiveSection(item.key);
                }}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="main-content">
        {activeSection === 'smart-search' ? (
          <div className="smart-search-layout">
            <section className="smart-search-main">
              <div className="smart-search-topbar">
                <h1>Умный поиск</h1>
                <div className="smart-top-actions">
                  <div className="balance-wrapper">
                    <button
                      type="button"
                      className="toolbar-btn"
                      title="Баланс совпадений"
                      onClick={() => {
                        setShowBalancePanel(!showBalancePanel);
                        setShowNotifications(false);
                      }}
                    >
                    <FourPointStar size={16} />
                      {smartMatchBalance > 0 && (
                        <span className="balance-badge">{smartMatchBalance}</span>
                      )}
                    </button>
                    {showBalancePanel && (
                      <BalancePanel
                        balance={smartMatchBalance}
                        onAddBalance={handleAddBalance}
                        onClose={() => setShowBalancePanel(false)}
                      />
                    )}
                  </div>
                  <div className="notifications-wrapper">
                    <button
                      type="button"
                      className="toolbar-btn"
                      title="Уведомления"
                      onClick={() => {
                        setShowNotifications(!showNotifications);
                        setShowBalancePanel(false);
                      }}
                    >
                      <Bell size={18} />
                      {notifications.length > 0 && (
                        <span className="notification-badge">{notifications.length}</span>
                      )}
                    </button>
                    {showNotifications && (
                      <div className="notifications-panel">
                        <div className="notifications-header">
                          <h4>Уведомления</h4>
                          {notifications.length > 0 && (
                            <button
                              className="clear-notifications-btn"
                              onClick={clearNotifications}
                            >
                              Очистить
                            </button>
                          )}
                        </div>
                        <div className="notifications-list">
                          {notifications.length === 0 ? (
                            <p className="no-notifications">Нет уведомлений</p>
                          ) : (
                            notifications.map(notification => (
                              <div key={notification.id} className="notification-item">
                                <div className="notification-icon">
                                  <Check size={14} />
                                </div>
                                <div className="notification-content">
                                  <p className="notification-message">{notification.message}</p>
                                  <span className="notification-time">
                                    {notification.timestamp.toLocaleTimeString('ru-RU', {
                                      hour: '2-digit',
                                      minute: '2-digit'
                                    })}
                                  </span>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="admin-wrapper">
                    <button
                      type="button"
                      className="toolbar-btn"
                      title="Профиль"
                      onClick={handleProfileClick}
                    >
                      <User size={18} />
                    </button>
                    {showAdminPanel && (
                      <div className="admin-panel">
                        {!isAdminAuthorized ? (
                          <div className="admin-login-form">
                            <h4>Вход в админку</h4>
                            <input
                              className="form-input"
                              placeholder="Логин"
                              value={adminLogin}
                              onChange={(event) => setAdminLogin(event.target.value)}
                            />
                            <input
                              className="form-input"
                              type="password"
                              placeholder="Пароль"
                              value={adminPassword}
                              onChange={(event) => setAdminPassword(event.target.value)}
                            />
                            <button
                              type="button"
                              className="btn btn-primary btn-full"
                              onClick={handleAdminLogin}
                            >
                              Войти
                            </button>
                          </div>
                        ) : (
                          <div className="admin-sources-form">
                            <h4>Источники поиска</h4>
                            <label className="smart-source-item">
                              <input
                                type="checkbox"
                                checked={adminSourcePreferences.pamyatNaroda}
                                onChange={() => handleAdminSourceToggle('pamyatNaroda')}
                              />
                              <span>Память народа</span>
                            </label>
                            <label className="smart-source-item">
                              <input
                                type="checkbox"
                                checked={adminSourcePreferences.openList}
                                onChange={() => handleAdminSourceToggle('openList')}
                              />
                              <span>Открытый список</span>
                            </label>
                            <label className="smart-source-item">
                              <input
                                type="checkbox"
                                checked={adminSourcePreferences.gwar}
                                onChange={() => handleAdminSourceToggle('gwar')}
                              />
                              <span>Герои войны</span>
                            </label>
                            <label className="smart-source-item">
                              <input
                                type="checkbox"
                                checked={adminSourcePreferences.userTrees}
                                onChange={() => handleAdminSourceToggle('userTrees')}
                              />
                              <span>Деревья пользователей</span>
                            </label>
                            <AdminScoreThresholdFields
                              thresholds={adminScoreThresholds}
                              onChange={handleAdminThresholdChange}
                            />
                            <button
                              type="button"
                              className="btn btn-primary btn-full"
                              onClick={handleAdminSave}
                              disabled={isAdminSaving}
                            >
                              {isAdminSaving ? 'Сохранение...' : 'Сохранить'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {smartSearchViewMode === 'list' ? (
                <>
                  <div className="smart-search-filters-row smart-search-top-filters">
                    <div className="smart-search-filters">
                      <button
                        type="button"
                        className={`smart-tab-chip ${smartSearchMatchTab === 'all' ? 'active' : ''}`}
                        onClick={() => handleSmartSearchTabChange('all')}
                      >
                        Все <span>{smartSearchTabCounts.all}</span>
                      </button>
                      <button
                        type="button"
                        className={`smart-tab-chip ${smartSearchMatchTab === 'tree' ? 'active' : ''}`}
                        onClick={() => handleSmartSearchTabChange('tree')}
                      >
                        Из деревьев <span>{smartSearchTabCounts.tree}</span>
                      </button>
                      <button
                        type="button"
                        className={`smart-tab-chip ${smartSearchMatchTab === 'archive' ? 'active' : ''}`}
                        onClick={() => handleSmartSearchTabChange('archive')}
                      >
                        Из архивов <span>{smartSearchTabCounts.archive}</span>
                      </button>
                      <button
                        type="button"
                        className={`smart-tab-chip ${smartSearchMatchTab === 'rejected' ? 'active' : ''}`}
                        onClick={() => handleSmartSearchTabChange('rejected')}
                      >
                        Отклоненные <span>{smartSearchTabCounts.rejected}</span>
                      </button>
                    </div>
                    <label className="smart-search-input-wrapper smart-search-cards-input">
                      <Search size={14} />
                      <input
                        className="smart-search-input"
                        type="text"
                        value={smartSearchQuery}
                        onChange={(event) => {
                          setSmartSearchFocusedPersonId(null);
                          setSmartSearchQuery(event.target.value);
                        }}
                        placeholder="Поиск по карточкам"
                      />
                      {smartSearchQuery && (
                        <button
                          type="button"
                          className="smart-search-clear-btn"
                          onClick={() => setSmartSearchQuery('')}
                          title="Очистить поиск"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>
                  </div>

                  {smartSearchStatus.running && (
                    <div className="smart-search-progress">
                      <div className="smart-search-progress-track">
                        <div
                          className="smart-search-progress-fill"
                          style={{ width: `${smartSearchProgressPercent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="smart-search-cards">
                    {visibleSmartSearchListCards.map((entry) => {
                        const { person, sourceType, id } = entry;
                        const isTreeEntry = sourceType === 'tree';
                        const personName = isTreeEntry
                          ? getTreeEntryTitle(entry)
                          : (getFullName(person) || 'Без имени');
                        const personGenderClass = isTreeEntry ? 'tree-owner' : getGenderClass(person);
                        const initials = isTreeEntry ? getOwnerInitials(entry.treeOwner) : getInitials(person);
                        const genderVerb = person?.gender === 'female' ? 'Найдена' : 'Найден';
                        const isStudied = studiedSmartSearchEntryKeys.includes(
                          getSmartSearchEntryStudyKey(entry)
                        );

                        return (
                          <article key={id} className="smart-match-card">
                            <span className={`smart-match-status-badge ${isStudied ? 'studied' : 'new'}`}>
                              {isStudied ? 'Изучено' : 'Новое'}
                            </span>
                            <div className={`smart-match-initials ${personGenderClass}`}>{initials}</div>
                            <div className="smart-match-content">
                              <div className="smart-match-top">
                                <h3 className="smart-match-name">{personName}</h3>
                              </div>
                              <div className="smart-match-footer">
                                <p>
                                  {isTreeEntry
                                    ? 'Из деревьев других пользователей'
                                    : `${genderVerb} в архиве`}
                                </p>
                                <button
                                  type="button"
                                  className="smart-study-btn"
                                  onClick={() => handleEnterSmartSearchExplore(entry)}
                                >
                                  Изучить совпадения
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    {visibleSmartSearchListCards.length === 0 && (
                        <p className="smart-empty-state">
                          Совпадений по выбранному разделу пока нет
                        </p>
                      )}
                  </div>
                </>
              ) : (
                <div className="smart-explore-view">
                  <button type="button" className="smart-back-btn" onClick={handleExitSmartSearchExplore}>
                    <ArrowLeft size={16} />
                    Назад
                  </button>
                  <div className="smart-explore-header">
                    <h2>
                      {isSmartSearchExploreTree
                        ? getTreeEntryTitle(smartSearchExploreEntry)
                        : (getFullName(smartSearchExplorePerson) || 'Без имени')}
                    </h2>
                    <div className="smart-explore-actions">
                      {smartSearchExploreEntry?.isMerged ? (
                        <button
                          type="button"
                          className="smart-reject-btn"
                          onClick={() => handleUndoSmartSearchTreeMerge(smartSearchExploreEntry)}
                          disabled={isSmartSearchActionProcessing}
                        >
                          {isSmartSearchActionProcessing ? 'Отмена...' : 'Отменить'}
                        </button>
                      ) : isSmartSearchExploreRejected ? (
                        <button
                          type="button"
                          className="smart-reject-btn"
                          onClick={() => handleRestoreSmartSearchCard(smartSearchExploreEntry)}
                        >
                          Восстановить
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="smart-reject-btn"
                            onClick={() => handleRejectSmartSearchCard(smartSearchExploreEntry)}
                          >
                            Отклонить
                          </button>
                          <button
                            type="button"
                            className="smart-access-btn"
                            onClick={() => {
                              if (!smartSearchExplorePerson) return;
                              if (smartSearchExploreHasLockedRecords) {
                                startSmartSearchCardPurchase(
                                  smartSearchExplorePerson,
                                  smartSearchExploreLockedTreeRecords,
                                  smartSearchExploreLockedArchiveRecords
                                );
                                return;
                              }
                              if (isSmartSearchExploreTree) {
                                handleMergeSmartSearchTree(smartSearchExploreEntry);
                                return;
                              }
                              handleAddAllUnlockedDocumentsForPerson(smartSearchExplorePerson, smartSearchExploreRecords);
                            }}
                            disabled={isSmartSearchActionProcessing}
                          >
                            {isSmartSearchActionProcessing && isSmartSearchExploreTree
                              ? 'Объединение...'
                              : isSmartSearchExploreTree
                              ? 'Объединить деревья'
                              : (smartSearchExploreHasLockedRecords ? 'Получить доступ' : 'Добавить')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isSmartSearchExploreTree && (
                    <div className="smart-tree-pairs">
                      {smartSearchExplorePairs.map(({ person: pairPerson, record }, index) => {
                        const isUnlocked = isSmartSearchRecordUnlocked(record);
                        return (
                          <div
                            key={`${pairPerson.id}-${record.database_id || index}`}
                            className="smart-tree-pair"
                          >
                            <article className="smart-detail-card">
                              <p className="smart-detail-source">Из вашего древа</p>
                              <div className="smart-detail-person">
                                <div className={`smart-match-initials ${getGenderClass(pairPerson)}`}>
                                  {getInitials(pairPerson)}
                                </div>
                                <h3>{getFullName(pairPerson) || 'Без имени'}</h3>
                              </div>
                              <div className="smart-detail-divider" />
                              <div className="smart-detail-fields">
                                <p><strong>Дата рождения:</strong> {formatDate(pairPerson.birthDate)}</p>
                                <p><strong>Место рождения:</strong> {pairPerson.birthPlace || 'Не указано'}</p>
                              </div>
                            </article>

                            <article className="smart-detail-card">
                              {typeof record.score === 'number' && (
                                <span className={`smart-match-score-badge ${getMatchScoreClass(record.score)}`}>
                                  {Math.round(record.score)}%
                                </span>
                              )}
                              <p className="smart-detail-source">
                                Из древа{' '}
                                <span className={!isUnlocked ? 'blurred-info' : ''}>
                                  {record.tree_owner || 'пользователя'}
                                </span>
                              </p>
                              <div className="smart-detail-person">
                                <div className={`smart-match-initials ${getGenderClass(record)}`}>
                                  {getInitials(record)}
                                </div>
                                <h3>{record.title || getPersonLabel(record)}</h3>
                              </div>
                              <div className="smart-detail-divider" />
                              <div className="smart-detail-fields">
                                <p><strong>Дата рождения:</strong> {formatDate(record.birthDate)}</p>
                                <p><strong>Место рождения:</strong> {record.birthPlace || 'Не указано'}</p>
                              </div>
                            </article>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!isSmartSearchExploreTree && smartSearchExplorePerson && (
                    <div className="smart-explore-compare">
                      <article className="smart-detail-card">
                        <p className="smart-detail-source">Из вашего древа</p>
                        <div className="smart-detail-person">
                          <div className={`smart-match-initials ${getGenderClass(smartSearchExplorePerson)}`}>
                            {getInitials(smartSearchExplorePerson)}
                          </div>
                          <h3>{getFullName(smartSearchExplorePerson) || 'Без имени'}</h3>
                        </div>
                        <div className="smart-detail-divider" />
                        <div className="smart-detail-fields">
                          <p><strong>Дата рождения:</strong> {formatDate(smartSearchExplorePerson.birthDate)}</p>
                          <p><strong>Место рождения:</strong> {smartSearchExplorePerson.birthPlace || 'Не указано'}</p>
                          <p><strong>Родители:</strong> {[
                            smartSearchExplorePerson.fatherId && people[smartSearchExplorePerson.fatherId] ? getFullName(people[smartSearchExplorePerson.fatherId]) : null,
                            smartSearchExplorePerson.motherId && people[smartSearchExplorePerson.motherId] ? getFullName(people[smartSearchExplorePerson.motherId]) : null
                          ].filter(Boolean).join(', ') || 'Не указаны'}</p>
                          <p><strong>Братья/Сестры:</strong> {Object.values(people).filter((candidate) => {
                            if (candidate.id === smartSearchExplorePerson.id) return false;
                            const sameFather = smartSearchExplorePerson.fatherId && candidate.fatherId === smartSearchExplorePerson.fatherId;
                            const sameMother = smartSearchExplorePerson.motherId && candidate.motherId === smartSearchExplorePerson.motherId;
                            return sameFather || sameMother;
                          }).map((sibling) => getFullName(sibling)).join(', ') || 'Не указаны'}</p>
                          <p><strong>Муж/Жена:</strong> {smartSearchExplorePerson.partnerId && people[smartSearchExplorePerson.partnerId] ? getFullName(people[smartSearchExplorePerson.partnerId]) : 'Не указан(а)'}</p>
                          <p><strong>Дети:</strong> {(smartSearchExplorePerson.children || []).map((childId) => people[childId]).filter(Boolean).map((child) => getFullName(child)).join(', ') || 'Не указаны'}</p>
                        </div>
                      </article>

                      <div className="smart-explore-sources">
                        {smartSearchExploreRecords.map((record, index) => {
                          const isTreeSource = isUserTreeRecord(record);
                          const isUnlocked = isSmartSearchRecordUnlocked(record);
                          const archiveLabel = `Из архива ${record.sourceLabel || 'Источник'}`;
                          const shouldBlurTreeOwner = isTreeSource && !isUnlocked;
                          const shouldBlurArchiveSource = !isTreeSource && !isUnlocked;
                          return (
                            <article key={`${getDocumentKey(record)}-${index}`} className="smart-detail-card">
                              {typeof record.score === 'number' && (
                                <span className={`smart-match-score-badge ${getMatchScoreClass(record.score)}`}>
                                  {Math.round(record.score)}%
                                </span>
                              )}
                              <p className="smart-detail-source">
                                {isTreeSource ? (
                                  <>
                                    Из древа{' '}
                                    <span className={shouldBlurTreeOwner ? 'blurred-info' : ''}>
                                      {record.tree_owner || 'пользователя'}
                                    </span>
                                  </>
                                ) : (
                                  <span className={shouldBlurArchiveSource ? 'blurred-info' : ''}>
                                    {archiveLabel}
                                  </span>
                                )}
                              </p>
                              <div>
                                <div className="smart-detail-person">
                                  <div className={`smart-match-initials ${getGenderClass(record)}`}>
                                    {getInitials(record)}
                                  </div>
                                  <h3>{record.title || getPersonLabel(record)}</h3>
                                </div>
                                <div className="smart-detail-divider" />
                                <div className="smart-detail-fields">
                                  <p><strong>Дата рождения:</strong> {formatDate(record.birthDate)}</p>
                                  <p><strong>Место рождения:</strong> {record.birthPlace || 'Не указано'}</p>
                                  <p><strong>Источник:</strong> {record.url ? (
                                    <a
                                      href={record.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className={`smart-source-link ${shouldBlurArchiveSource ? 'blurred-info' : ''}`}
                                    >
                                      Открыть ссылку
                                    </a>
                                  ) : 'Не указан'}
                                  </p>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        ) : activeSection === 'tree' ? (
          <>
            <div className="tree-container">
              <FamilyTree
                people={treeView.visiblePeople}
                selectedPerson={selectedPerson}
                onSelectPerson={handleSelectPerson}
                onMatchClick={handleMatchClick}
                zoom={zoom}
                pan={pan}
                onPanChange={setPan}
                collapsedGroups={treeView.collapsedGroups}
                onToggleGroup={handleToggleGroup}
              />
            </div>

            {/* Right Toolbar */}
            <div className="right-toolbar">
              <div className="admin-wrapper">
                <button className="toolbar-btn" title="Профиль" onClick={handleProfileClick}>
                  <User size={18} />
                </button>
                {showAdminPanel && (
                  <div className="admin-panel">
                    {!isAdminAuthorized ? (
                      <div className="admin-login-form">
                        <h4>Вход в админку</h4>
                        <input
                          className="form-input"
                          placeholder="Логин"
                          value={adminLogin}
                          onChange={(event) => setAdminLogin(event.target.value)}
                        />
                        <input
                          className="form-input"
                          type="password"
                          placeholder="Пароль"
                          value={adminPassword}
                          onChange={(event) => setAdminPassword(event.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-primary btn-full"
                          onClick={handleAdminLogin}
                        >
                          Войти
                        </button>
                      </div>
                    ) : (
                      <div className="admin-sources-form">
                        <h4>Источники поиска</h4>
                        <label className="smart-source-item">
                          <input
                            type="checkbox"
                            checked={adminSourcePreferences.pamyatNaroda}
                            onChange={() => handleAdminSourceToggle('pamyatNaroda')}
                          />
                          <span>Память народа</span>
                        </label>
                        <label className="smart-source-item">
                          <input
                            type="checkbox"
                            checked={adminSourcePreferences.openList}
                            onChange={() => handleAdminSourceToggle('openList')}
                          />
                          <span>Открытый список</span>
                        </label>
                        <label className="smart-source-item">
                          <input
                            type="checkbox"
                            checked={adminSourcePreferences.gwar}
                            onChange={() => handleAdminSourceToggle('gwar')}
                          />
                          <span>Герои войны</span>
                        </label>
                        <label className="smart-source-item">
                          <input
                            type="checkbox"
                            checked={adminSourcePreferences.userTrees}
                            onChange={() => handleAdminSourceToggle('userTrees')}
                          />
                          <span>Деревья пользователей</span>
                        </label>
                        <AdminScoreThresholdFields
                          thresholds={adminScoreThresholds}
                          onChange={handleAdminThresholdChange}
                        />
                        <button
                          type="button"
                          className="btn btn-primary btn-full"
                          onClick={handleAdminSave}
                          disabled={isAdminSaving}
                        >
                          {isAdminSaving ? 'Сохранение...' : 'Сохранить'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Balance Panel */}
              <div className="balance-wrapper">
                <button
                  className="toolbar-btn"
                  title="Баланс совпадений"
                  onClick={() => {
                    setShowBalancePanel(!showBalancePanel);
                    setShowNotifications(false);
                  }}
                >
                  <FourPointStar size={16} />
                  {smartMatchBalance > 0 && (
                    <span className="balance-badge">{smartMatchBalance}</span>
                  )}
                </button>
                {showBalancePanel && (
                  <BalancePanel
                    balance={smartMatchBalance}
                    onAddBalance={handleAddBalance}
                    onClose={() => setShowBalancePanel(false)}
                  />
                )}
              </div>

              <div className="notifications-wrapper">
                <button
                  className="toolbar-btn"
                  title="Уведомления"
                  onClick={() => {
                    setShowNotifications(!showNotifications);
                    setShowBalancePanel(false);
                  }}
                >
                  <Bell size={18} />
                  {notifications.length > 0 && (
                    <span className="notification-badge">{notifications.length}</span>
                  )}
                </button>
                {showNotifications && (
                  <div className="notifications-panel">
                    <div className="notifications-header">
                      <h4>Уведомления</h4>
                      {notifications.length > 0 && (
                        <button
                          className="clear-notifications-btn"
                          onClick={clearNotifications}
                        >
                          Очистить
                        </button>
                      )}
                    </div>
                    <div className="notifications-list">
                      {notifications.length === 0 ? (
                        <p className="no-notifications">Нет уведомлений</p>
                      ) : (
                        notifications.map(notification => (
                          <div key={notification.id} className="notification-item">
                            <div className="notification-icon">
                              <Check size={14} />
                            </div>
                            <div className="notification-content">
                              <p className="notification-message">{notification.message}</p>
                              <span className="notification-time">
                                {notification.timestamp.toLocaleTimeString('ru-RU', {
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
                      <button className="toolbar-btn" title="Поиск">
                        <Search size={16} />
              </button>
              <button className="toolbar-btn" title="Где я" onClick={handleCenterTree}>
                <Navigation size={18} />
              </button>
              <button className="toolbar-btn" title="Загрузить" onClick={handleUploadClick}>
                <Upload size={18} />
              </button>
              <button className="toolbar-btn" title="Скачать" onClick={handleDownload}>
                <Download size={18} />
              </button>
              <button className="toolbar-btn" title="Другое">
                <MoreHorizontal size={18} />
              </button>
              <button className="toolbar-btn" title="Приблизить" onClick={handleZoomIn}>
                <Plus size={18} />
              </button>
              <button className="toolbar-btn" title="Отдалить" onClick={handleZoomOut}>
                <Minus size={18} />
              </button>
            </div>
          </>
        ) : (
          <section className="section-under-development">
            <p>Этот раздел пока в разработке</p>
          </section>
        )}
      </div>

      {activeSection === 'tree' && selectedPerson && !showEditModal && !showAddRelativeModal && (
        <PersonCard
          person={selectedPerson}
          people={people}
          onClose={() => setSelectedPerson(null)}
          onEdit={handleEdit}
          onAddRelative={handleAddRelative}
          onDelete={handleDelete}
          onSelectPerson={handleSelectPerson}
        />
      )}

      <EditModal
        isOpen={showEditModal}
        person={selectedPerson}
        onSave={handleSaveEdit}
        onClose={() => setShowEditModal(false)}
      />

      <AddRelativeModal
        isOpen={showAddRelativeModal}
        person={selectedPerson}
        availableRelations={availableRelations}
        initialRelation={initialRelation}
        onAdd={handleSaveRelative}
        onClose={() => setShowAddRelativeModal(false)}
      />

      <ConfirmDialog
        isOpen={showConfirmDelete}
        title="Удалить запись?"
        message={`Вы уверены, что хотите удалить ${getFullName(selectedPerson)}? Это действие нельзя отменить.`}
        onConfirm={handleConfirmDelete}
        onCancel={() => setShowConfirmDelete(false)}
      />

      <MatchVerificationModal
        isOpen={showMatchModal}
        person={matchPerson}
        treeMatches={treeMatches}
        archiveMatches={archiveMatches}
        onConfirmTree={handleConfirmTreeMatch}
        onConfirmArchive={handleConfirmArchiveMatch}
        onClose={() => {
          setShowMatchModal(false);
          setMatchPerson(null);
          setTreeMatches([]);
          setArchiveMatches([]);
        }}
        smartMatchBalance={smartMatchBalance}
        onAddBalance={handleAddBalance}
        onSpendBalance={handleSpendBalance}
        grantedAccessIds={grantedAccessIds}
        onGrantAccess={handleGrantAccess}
      />

      {showSmartSearchPaymentModal && (
        <div className="modal-overlay payment-modal" onClick={() => !isSmartSearchActionProcessing && resetSmartSearchActionState()}>
          <div className="modal-content payment-content" onClick={(e) => e.stopPropagation()}>
            {showSmartSearchPaymentSuccess ? (
              <div className="payment-success">
                <Check size={48} className="success-icon" />
                <h3>Оплата прошла успешно!</h3>
                <p>Добавлено {smartSearchSelectedPlan === 'package' ? 10 : smartSearchBasicQuantity} совпадений</p>
              </div>
            ) : (
              <>
                <div className="payment-header">
                  <CreditCard size={32} className="payment-icon" />
                  <h3>Пополнение баланса</h3>
                </div>
                {smartSearchRequiredMatches > 1 && (
                  <p className="payment-notice">
                    Для {smartSearchActionTitle} требуется минимум {smartSearchRequiredMatches} совпадений
                  </p>
                )}
                <div className="payment-plans">
                  <div
                    className={`payment-plan ${smartSearchSelectedPlan === 'basic' ? 'selected' : ''}`}
                    onClick={() => setSmartSearchSelectedPlan('basic')}
                  >
                    <div className="plan-header">
                      <h4>Базовый</h4>
                      <span className="plan-price">{smartSearchPaymentBasicPrice} ₽</span>
                    </div>
                    <p className="plan-desc">за 1 совпадение</p>
                    <div className="plan-quantity">
                      <button
                        className="quantity-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSmartSearchBasicQuantity((prev) => Math.max(smartSearchRequiredMatches, prev - 1));
                        }}
                        disabled={smartSearchBasicQuantity <= smartSearchRequiredMatches}
                      >
                        <Minus size={14} />
                      </button>
                      <span className="quantity-value">{smartSearchBasicQuantity}</span>
                      <button
                        className="quantity-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSmartSearchBasicQuantity((prev) => prev + 1);
                        }}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <div className="plan-total">
                      Итого: <strong>{smartSearchPaymentBasicTotal} ₽</strong>
                    </div>
                  </div>
                  <div
                    className={`payment-plan package ${smartSearchSelectedPlan === 'package' ? 'selected' : ''}`}
                    onClick={() => setSmartSearchSelectedPlan('package')}
                  >
                    <div className="plan-badge">Выгодно</div>
                    <div className="plan-header">
                      <h4>Пакет</h4>
                      <span className="plan-price">{smartSearchPaymentPackagePrice} ₽</span>
                    </div>
                    <p className="plan-desc">за 10 совпадений</p>
                    <p className="plan-savings">Экономия {10 * smartSearchPaymentBasicPrice - smartSearchPaymentPackagePrice} ₽</p>
                    <div className="plan-total">
                      <strong>{smartSearchPaymentPackagePrice} ₽</strong>
                    </div>
                  </div>
                </div>
                <button
                  className="btn btn-primary payment-btn"
                  onClick={handleSmartSearchBuyMatches}
                  disabled={isSmartSearchActionProcessing}
                >
                  {isSmartSearchActionProcessing ? (
                    <>
                      <div className="btn-spinner" />
                      Обработка...
                    </>
                  ) : (
                    <>
                      <CreditCard size={16} />
                      Оплатить {smartSearchSelectedPlan === 'package' ? smartSearchPaymentPackagePrice : smartSearchPaymentBasicTotal} ₽
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showSmartSearchConfirmModal && (
        <div className="modal-overlay confirm-purchase-modal" onClick={resetSmartSearchActionState}>
          <div className="modal-content confirm-purchase-content" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-purchase-header">
              <FourPointStar size={24} className="confirm-purchase-icon" />
              <h3>Подтверждение</h3>
            </div>
            <p className="confirm-purchase-text">
              Вы хотите приобрести {smartSearchPurchaseTitle} за <strong>1 совпадение</strong>?
            </p>
            <p className="confirm-purchase-balance">
              Текущий баланс: <strong>{smartMatchBalance}</strong> совпадений
            </p>
            <div className="confirm-purchase-actions">
              <button className="btn btn-secondary" onClick={resetSmartSearchActionState}>
                Отмена
              </button>
              <button className="btn btn-primary" onClick={handleSmartSearchConfirmPurchase}>
                <Check size={16} />
                Подтвердить
              </button>
            </div>
          </div>
        </div>
      )}

      {showSmartSearchRequestModal && (
        <div className="modal-overlay request-modal" onClick={() => !isSmartSearchActionProcessing && resetSmartSearchActionState()}>
          <div className="modal-content request-content" onClick={(e) => e.stopPropagation()}>
            <div className="request-header">
              <Send size={24} className="request-icon" />
              <h3>{smartSearchActionContext?.type === 'treeMerge' ? 'Объединение деревьев' : 'Запрос доступа'}</h3>
            </div>
            <p className="request-recipient">
              Кому: <strong>{smartSearchActionContext?.treeOwners?.join(', ') || 'Владелец дерева'}</strong>
            </p>
            <textarea
              className="request-textarea"
              value={smartSearchRequestMessage}
              onChange={(event) => setSmartSearchRequestMessage(event.target.value)}
              rows={4}
              disabled={isSmartSearchActionProcessing}
            />
            <button
              className="btn btn-primary request-btn"
              onClick={handleSmartSearchSendRequest}
              disabled={isSmartSearchActionProcessing}
            >
              {isSmartSearchActionProcessing ? (
                <>
                  <div className="btn-spinner" />
                  Отправка...
                </>
              ) : (
                <>
                  <Send size={16} />
                  Отправить
                </>
              )}
            </button>
          </div>
        </div>
      )}

      <input
        ref={uploadInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      {/* Smart Search Found Notification */}
      {showMatchFoundNotification && (
        <div 
          className="smartmatching-notification"
          onClick={handleMatchNotificationClick}
        >
          <div className="smartmatching-notification-icon">
            <FourPointStar size={16} />
          </div>
          <div className="smartmatching-notification-content">
            <p className="smartmatching-notification-title">Мы нашли ваших родственников</p>
            <p className="smartmatching-notification-subtitle">Нажмите для подробностей</p>
          </div>
        </div>
      )}

      {/* Smart Search Tutorial Modal */}
      {showSmartMatchingTutorial && (
        <div className="modal-overlay smartmatching-tutorial-overlay" onClick={handleTutorialClose}>
          <div className="smartmatching-tutorial-modal" onClick={e => e.stopPropagation()}>
            <button className="smartmatching-tutorial-close" onClick={handleTutorialClose}>
              <X size={20} />
            </button>
            
            <div className="smartmatching-tutorial-header">
              <h3>Умный поиск</h3>
              <span className="smartmatching-tutorial-step">Шаг {tutorialStep} из 3</span>
            </div>

            <div className="smartmatching-tutorial-body">
              <div className="smartmatching-tutorial-text">
                {tutorialStep === 1 && (
                  <p>Умный поиск позволяет находить ваших родственников в деревьях других людей и архивных данных. Расширяйте ваше древо одним нажатием.</p>
                )}
                {tutorialStep === 2 && (
                  <p>Мы уделяем особое внимание защите персональных данных наших клиентов. Для добавления родственников из другого древа необходимо запросить доступ у владельца.</p>
                )}
                {tutorialStep === 3 && (
                  <p>Попробуйте умный поиск прямо сейчас!</p>
                )}
              </div>
              
              <div className="smartmatching-tutorial-image">
                <img 
                  src={`/assets/instruction_${tutorialStep}.gif`} 
                  alt={`Инструкция шаг ${tutorialStep}`}
                  onError={(e) => {
                    e.target.style.display = 'none';
                    e.target.parentElement.innerHTML = `<div class="tutorial-image-placeholder"><span>Шаг ${tutorialStep}</span></div>`;
                  }}
                />
              </div>
            </div>

            <div className="smartmatching-tutorial-footer">
              <div className="smartmatching-tutorial-dots">
                {[1, 2, 3].map(step => (
                  <span 
                    key={step} 
                    className={`tutorial-dot ${tutorialStep === step ? 'active' : ''}`}
                  />
                ))}
              </div>
              <button 
                className="smartmatching-tutorial-next"
                onClick={handleTutorialNext}
              >
                {tutorialStep === 3 ? (
                  'Приступить'
                ) : (
                  <ChevronRight size={24} />
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="toast-container">
        {toasts.map(toast => (
          <Toast
            key={toast.id}
            message={toast.message}
            type={toast.type}
            onClose={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </div>
  );
}

export default App;
