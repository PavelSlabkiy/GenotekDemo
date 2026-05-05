import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  User, 
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
  RefreshCw,
  TreePine,
  ChevronRight,
  Users,
  Plus,
  Minus,
  Search,
  Download,
  Navigation,
  MoreHorizontal,
  Lock,
  Send,
  CreditCard,
  Bell,
  Coins
} from 'lucide-react';

const API_URL = '/api';

// Layout constants
const CARD_WIDTH = 140;
const CARD_HEIGHT = 110;
const HORIZONTAL_GAP = 50;
const VERTICAL_GAP = 100;
const COUPLE_GAP = 80;
const PADDING = 60;

// Helper function to format date
const formatDate = (dateStr) => {
  if (!dateStr) return 'Не указана';
  const date = new Date(dateStr);
  return date.toLocaleDateString('ru-RU', { 
    day: 'numeric', 
    month: 'long', 
    year: 'numeric' 
  });
};

// Get full name
const getFullName = (person) => {
  if (!person) return '';
  return `${person.lastName || ''} ${person.name || ''} ${person.middleName || ''}`.trim();
};

// ============================================
// TREE LAYOUT ENGINE
// ============================================

class TreeLayoutEngine {
  constructor(people) {
    this.people = people;
    this.positions = new Map(); // personId -> { x, y }
    this.generations = new Map(); // personId -> generation level (0 = youngest)
  }

  // Calculate generation for each person (0 = youngest/leaves, higher = older)
  calculateGenerations() {
    const people = Object.values(this.people);
    if (people.length === 0) return;

    // Calculate generation based on descendants (bottom-up)
    const getGeneration = (personId, visited = new Set()) => {
      if (visited.has(personId)) return 0;
      visited.add(personId);
      
      if (this.generations.has(personId)) {
        return this.generations.get(personId);
      }

      const person = this.people[personId];
      if (!person) return 0;

      const children = (person.children || [])
        .map(id => this.people[id])
        .filter(Boolean);

      if (children.length === 0) {
        this.generations.set(personId, 0);
        return 0;
      }

      let maxChildGen = 0;
      children.forEach(child => {
        maxChildGen = Math.max(maxChildGen, getGeneration(child.id, new Set(visited)));
      });

      const gen = maxChildGen + 1;
      this.generations.set(personId, gen);
      return gen;
    };

    people.forEach(p => getGeneration(p.id));

    // Ensure partners are on the same generation
    people.forEach(person => {
      if (person.partnerId && this.people[person.partnerId]) {
        const personGen = this.generations.get(person.id) || 0;
        const partnerGen = this.generations.get(person.partnerId) || 0;
        const maxGen = Math.max(personGen, partnerGen);
        this.generations.set(person.id, maxGen);
        this.generations.set(person.partnerId, maxGen);
      }
    });

    // Check parent relationships
    people.forEach(person => {
      const father = person.fatherId ? this.people[person.fatherId] : null;
      const mother = person.motherId ? this.people[person.motherId] : null;
      const personGen = this.generations.get(person.id) || 0;
      
      if (father) {
        const fatherGen = this.generations.get(father.id) || 0;
        if (fatherGen <= personGen) {
          this.generations.set(father.id, personGen + 1);
        }
      }
      if (mother) {
        const motherGen = this.generations.get(mother.id) || 0;
        if (motherGen <= personGen) {
          this.generations.set(mother.id, personGen + 1);
        }
      }
    });

    // Final pass - ensure partners match
    people.forEach(person => {
      if (person.partnerId && this.people[person.partnerId]) {
        const personGen = this.generations.get(person.id) || 0;
        const partnerGen = this.generations.get(person.partnerId) || 0;
        const maxGen = Math.max(personGen, partnerGen);
        this.generations.set(person.id, maxGen);
        this.generations.set(person.partnerId, maxGen);
      }
    });
  }

  // Calculate width needed for a person's ancestor subtree
  getSubtreeWidth(personId, visited = new Set()) {
    if (visited.has(personId)) return CARD_WIDTH;
    visited.add(personId);

    const person = this.people[personId];
    if (!person) return CARD_WIDTH;

    const father = person.fatherId ? this.people[person.fatherId] : null;
    const mother = person.motherId ? this.people[person.motherId] : null;

    // If person has both parents, we need width for both parent subtrees
    if (father && mother) {
      const fatherSubtree = this.getSubtreeWidth(father.id, new Set(visited));
      const motherSubtree = this.getSubtreeWidth(mother.id, new Set(visited));
      return fatherSubtree + HORIZONTAL_GAP + motherSubtree;
    } else if (father) {
      return this.getSubtreeWidth(father.id, new Set(visited));
    } else if (mother) {
      return this.getSubtreeWidth(mother.id, new Set(visited));
    }

    return CARD_WIDTH;
  }

  // Position ancestors recursively (going UP the tree)
  positionAncestors(personId, personX, maxGen) {
    const person = this.people[personId];
    if (!person) return;

    const gen = this.generations.get(personId);
    const father = person.fatherId ? this.people[person.fatherId] : null;
    const mother = person.motherId ? this.people[person.motherId] : null;

    if (!father && !mother) return;

    const parentY = (maxGen - gen - 1) * (CARD_HEIGHT + VERTICAL_GAP) + PADDING;

    if (father && mother) {
      // Both parents - position them as a couple centered above the child
      // Calculate subtree widths for each parent
      const fatherSubtreeWidth = this.getSubtreeWidth(father.id, new Set([personId]));
      const motherSubtreeWidth = this.getSubtreeWidth(mother.id, new Set([personId]));

      // Father's center should be at personX - offset
      // Mother's center should be at personX + offset
      // The offset is calculated so each parent is centered over their subtree
      
      const fatherX = personX - fatherSubtreeWidth / 2;
      const motherX = personX + motherSubtreeWidth / 2;

      // Ensure minimum gap between parents
      const actualGap = motherX - fatherX;
      if (actualGap < CARD_WIDTH + COUPLE_GAP) {
        const adjustment = (CARD_WIDTH + COUPLE_GAP - actualGap) / 2;
        const adjustedFatherX = fatherX - adjustment;
        const adjustedMotherX = motherX + adjustment;
        
        if (!this.positions.has(father.id)) {
          this.positions.set(father.id, { x: adjustedFatherX, y: parentY });
          this.positionAncestors(father.id, adjustedFatherX, maxGen);
        }
        if (!this.positions.has(mother.id)) {
          this.positions.set(mother.id, { x: adjustedMotherX, y: parentY });
          this.positionAncestors(mother.id, adjustedMotherX, maxGen);
        }
      } else {
        if (!this.positions.has(father.id)) {
          this.positions.set(father.id, { x: fatherX, y: parentY });
          this.positionAncestors(father.id, fatherX, maxGen);
        }
        if (!this.positions.has(mother.id)) {
          this.positions.set(mother.id, { x: motherX, y: parentY });
          this.positionAncestors(mother.id, motherX, maxGen);
        }
      }
    } else if (father) {
      // Only father - position directly above
      if (!this.positions.has(father.id)) {
        this.positions.set(father.id, { x: personX, y: parentY });
        this.positionAncestors(father.id, personX, maxGen);
      }
    } else if (mother) {
      // Only mother - position directly above
      if (!this.positions.has(mother.id)) {
        this.positions.set(mother.id, { x: personX, y: parentY });
        this.positionAncestors(mother.id, personX, maxGen);
      }
    }
  }

  // Main layout calculation
  calculateLayout() {
    this.calculateGenerations();

    const people = Object.values(this.people);
    if (people.length === 0) return;

    const maxGen = Math.max(...Array.from(this.generations.values()));
    const minGen = Math.min(...Array.from(this.generations.values()));

    // Find youngest generation people (focal points)
    const youngestPeople = people.filter(p => this.generations.get(p.id) === minGen);

    // Group youngest into couples/singles
    const processedYoungest = new Set();
    const youngestUnits = [];

    youngestPeople.forEach(person => {
      if (processedYoungest.has(person.id)) return;

      const partner = person.partnerId ? this.people[person.partnerId] : null;
      const partnerSameGen = partner && this.generations.get(partner.id) === minGen;

      if (partnerSameGen && !processedYoungest.has(partner.id)) {
        youngestUnits.push({ type: 'couple', person1: person, person2: partner });
        processedYoungest.add(person.id);
        processedYoungest.add(partner.id);
      } else {
        youngestUnits.push({ type: 'single', person: person });
        processedYoungest.add(person.id);
      }
    });

    // Calculate total width needed and position youngest generation
    let currentX = PADDING;
    const youngestY = maxGen * (CARD_HEIGHT + VERTICAL_GAP) + PADDING;

    youngestUnits.forEach((unit, index) => {
      if (index > 0) currentX += HORIZONTAL_GAP * 2;

      if (unit.type === 'couple') {
        const { person1, person2 } = unit;
        
        // Calculate subtree widths
        const p1SubtreeWidth = this.getSubtreeWidth(person1.id, new Set());
        const p2SubtreeWidth = this.getSubtreeWidth(person2.id, new Set([person1.id]));
        
        const totalWidth = Math.max(
          p1SubtreeWidth + HORIZONTAL_GAP + p2SubtreeWidth,
          CARD_WIDTH * 2 + COUPLE_GAP
        );

        // Position person1 centered over their subtree (left side)
        const p1X = currentX + p1SubtreeWidth / 2;
        // Position person2 centered over their subtree (right side)  
        const p2X = currentX + p1SubtreeWidth + HORIZONTAL_GAP + p2SubtreeWidth / 2;

        this.positions.set(person1.id, { x: p1X, y: youngestY });
        this.positions.set(person2.id, { x: p2X, y: youngestY });

        // Position ancestors for each
        this.positionAncestors(person1.id, p1X, maxGen);
        this.positionAncestors(person2.id, p2X, maxGen);

        currentX += totalWidth;
      } else {
        const person = unit.person;
        const subtreeWidth = this.getSubtreeWidth(person.id, new Set());
        const personX = currentX + subtreeWidth / 2;

        this.positions.set(person.id, { x: personX, y: youngestY });
        this.positionAncestors(person.id, personX, maxGen);
        
        currentX += subtreeWidth;
      }
    });

    // Resolve any overlaps that might have occurred
    for (let gen = minGen; gen <= maxGen; gen++) {
      const genY = (maxGen - gen) * (CARD_HEIGHT + VERTICAL_GAP) + PADDING;
      this.resolveOverlaps(genY);
    }
  }

  // Resolve overlapping positions in a generation
  resolveOverlaps(genY) {
    const genPeople = Array.from(this.positions.entries())
      .filter(([id, pos]) => Math.abs(pos.y - genY) < 1)
      .sort((a, b) => a[1].x - b[1].x);

    for (let i = 1; i < genPeople.length; i++) {
      const [prevId, prevPos] = genPeople[i - 1];
      const [currId, currPos] = genPeople[i];

      // Check if they are partners - allow closer spacing for couples
      const prevPerson = this.people[prevId];
      const currPerson = this.people[currId];
      const arePartners = prevPerson?.partnerId === currId || currPerson?.partnerId === prevId;
      
      const minDistance = arePartners ? CARD_WIDTH + COUPLE_GAP : CARD_WIDTH + HORIZONTAL_GAP;
      const actualDistance = currPos.x - prevPos.x;

      if (actualDistance < minDistance) {
        const shift = minDistance - actualDistance;
        // Shift current and all subsequent positions to the right
        for (let j = i; j < genPeople.length; j++) {
          const [shiftId, shiftPos] = genPeople[j];
          this.positions.set(shiftId, { x: shiftPos.x + shift, y: shiftPos.y });
        }
        genPeople[i] = [currId, { x: currPos.x + shift, y: currPos.y }];
      }
    }
  }

  // Get calculated layout with normalized positions
  getLayout() {
    this.calculateLayout();
    
    if (this.positions.size === 0) {
      return { positions: new Map(), canvasWidth: PADDING * 2, canvasHeight: PADDING * 2 };
    }

    // Normalize positions
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

    let maxX = 0;
    let maxY = 0;
    
    normalizedPositions.forEach(pos => {
      maxX = Math.max(maxX, pos.x + CARD_WIDTH / 2);
      maxY = Math.max(maxY, pos.y + CARD_HEIGHT);
    });

    return {
      positions: normalizedPositions,
      canvasWidth: maxX + PADDING,
      canvasHeight: maxY + PADDING
    };
  }
}

// ============================================
// CONNECTOR LINES COMPONENT
// ============================================

const TreeConnectors = ({ people, positions, width, height }) => {
  const lines = useMemo(() => {
    const connectorLines = [];
    const processedCouples = new Set();
    const processedParentChild = new Set();

    Object.values(people).forEach(person => {
      const personPos = positions.get(person.id);
      if (!personPos) return;

      // Partner connection line
      if (person.partnerId && people[person.partnerId]) {
        const coupleKey = [person.id, person.partnerId].sort().join('-');
        if (!processedCouples.has(coupleKey)) {
          processedCouples.add(coupleKey);
          
          const partnerPos = positions.get(person.partnerId);
          if (partnerPos) {
            const y = personPos.y + CARD_HEIGHT / 2;
            connectorLines.push({
              type: 'couple',
              key: `couple-${coupleKey}`,
              x1: Math.min(personPos.x, partnerPos.x),
              y1: y,
              x2: Math.max(personPos.x, partnerPos.x),
              y2: y
            });

            // Children connector from couple
            const partner = people[person.partnerId];
            const childrenIds = new Set([
              ...(person.children || []),
              ...(partner.children || [])
            ]);

            const children = Array.from(childrenIds)
              .map(id => people[id])
              .filter(child => child && positions.has(child.id));

            if (children.length > 0) {
              const coupleCenterX = (personPos.x + partnerPos.x) / 2;
              const coupleCenterY = y;
              const childY = Math.min(...children.map(c => positions.get(c.id).y));
              const branchY = coupleCenterY + (childY - coupleCenterY - CARD_HEIGHT) / 2 + CARD_HEIGHT / 2;

              // Vertical line from couple to branch point
              connectorLines.push({
                type: 'vertical',
                key: `couple-down-${coupleKey}`,
                x1: coupleCenterX,
                y1: coupleCenterY,
                x2: coupleCenterX,
                y2: branchY
              });

              if (children.length === 1) {
                // Single child - straight line down
                const childPos = positions.get(children[0].id);
                connectorLines.push({
                  type: 'vertical',
                  key: `child-${children[0].id}`,
                  x1: coupleCenterX,
                  y1: branchY,
                  x2: childPos.x,
                  y2: childPos.y
                });
              } else {
                // Multiple children - horizontal branch then down to each
                const childXPositions = children.map(c => positions.get(c.id).x);
                const leftX = Math.min(...childXPositions);
                const rightX = Math.max(...childXPositions);

                // Horizontal branch line
                connectorLines.push({
                  type: 'horizontal',
                  key: `branch-${coupleKey}`,
                  x1: leftX,
                  y1: branchY,
                  x2: rightX,
                  y2: branchY
                });

                // Vertical lines to each child
                children.forEach(child => {
                  const childPos = positions.get(child.id);
                  const pKey = `parent-child-${coupleKey}-${child.id}`;
                  if (!processedParentChild.has(pKey)) {
                    processedParentChild.add(pKey);
                    connectorLines.push({
                      type: 'vertical',
                      key: `to-child-${child.id}`,
                      x1: childPos.x,
                      y1: branchY,
                      x2: childPos.x,
                      y2: childPos.y
                    });
                  }
                });
              }
            }
          }
        }
      } else if (!person.partnerId) {
        // Single parent with children
        const children = (person.children || [])
          .map(id => people[id])
          .filter(child => child && positions.has(child.id));

        if (children.length > 0) {
          const parentKey = `single-${person.id}`;
          if (!processedCouples.has(parentKey)) {
            processedCouples.add(parentKey);

            const parentCenterY = personPos.y + CARD_HEIGHT / 2;
            const childY = Math.min(...children.map(c => positions.get(c.id).y));
            const branchY = parentCenterY + (childY - parentCenterY - CARD_HEIGHT) / 2 + CARD_HEIGHT / 2;

            // Vertical line from parent to branch
            connectorLines.push({
              type: 'vertical',
              key: `single-down-${person.id}`,
              x1: personPos.x,
              y1: personPos.y + CARD_HEIGHT,
              x2: personPos.x,
              y2: branchY
            });

            if (children.length === 1) {
              const childPos = positions.get(children[0].id);
              connectorLines.push({
                type: 'vertical',
                key: `single-child-${children[0].id}`,
                x1: personPos.x,
                y1: branchY,
                x2: childPos.x,
                y2: childPos.y
              });
            } else {
              const childXPositions = children.map(c => positions.get(c.id).x);
              const leftX = Math.min(...childXPositions);
              const rightX = Math.max(...childXPositions);

              connectorLines.push({
                type: 'horizontal',
                key: `single-branch-${person.id}`,
                x1: leftX,
                y1: branchY,
                x2: rightX,
                y2: branchY
              });

              children.forEach(child => {
                const childPos = positions.get(child.id);
                connectorLines.push({
                  type: 'vertical',
                  key: `single-to-child-${child.id}`,
                  x1: childPos.x,
                  y1: branchY,
                  x2: childPos.x,
                  y2: childPos.y
                });
              });
            }
          }
        }
      }
    });

    return connectorLines;
  }, [people, positions]);

  return (
    <svg className="tree-connectors" width={width} height={height}>
      {lines.map(line => (
        <line
          key={line.key}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          strokeLinecap="round"
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
  const birthYear = person.birthDate ? new Date(person.birthDate).getFullYear() : null;

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
            <RefreshCw size={14} />
          </button>
          <div className="match-tooltip">
            SmartMatching — позволяет находить ваших родственников в деревьях других людей и архивных данных.
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

const FamilyTree = ({ people, selectedPerson, onSelectPerson, onMatchClick, zoom, pan, onPanChange }) => {
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
          people={people}
          positions={layout.positions}
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
      </div>
    </div>
  );
};

// ============================================
// MODAL COMPONENTS
// ============================================

// Toast Component
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

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
    information: ''
  });

  useEffect(() => {
    if (person) {
      setFormData({
        name: person.name || '',
        lastName: person.lastName || '',
        middleName: person.middleName || '',
        birthDate: person.birthDate || '',
        birthPlace: person.birthPlace || '',
        information: person.information || ''
      });
    }
  }, [person]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData);
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
              <input
                type="date"
                className="form-input"
                value={formData.birthDate}
                onChange={e => setFormData({...formData, birthDate: e.target.value})}
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
      onAdd(selectedRelation, formData);
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
                  <input
                    type="date"
                    className="form-input"
                    value={formData.birthDate}
                    onChange={e => setFormData({...formData, birthDate: e.target.value})}
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
            <Coins size={24} />
            <span className="balance-value">{balance}</span>
            <span className="balance-label">SmartMatch</span>
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
                <p>Добавлено {selectedPlan === 'package' ? 10 : quantity} SmartMatch</p>
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
                    <p className="plan-desc">за 1 SmartMatch</p>
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
                    <p className="plan-desc">за 10 SmartMatch</p>
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
              <p>Добавлено {selectedPlan === 'package' ? 10 : basicQuantity} SmartMatch</p>
            </div>
          ) : (
            <>
              <div className="payment-header">
                <CreditCard size={32} className="payment-icon" />
                <h3>Пополнение баланса</h3>
              </div>
              {requiredMatches > 1 && (
                <p className="payment-notice">
                  Для добавления родственников требуется минимум {requiredMatches} SmartMatch
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
                  <p className="plan-desc">за 1 SmartMatch</p>
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
                  <p className="plan-desc">за 10 SmartMatch</p>
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
            <Coins size={32} className="confirm-purchase-icon" />
            <h3>Подтверждение</h3>
          </div>
          <p className="confirm-purchase-text">
            Вы хотите добавить <strong>{relativesCount}</strong> {relativesCount === 1 ? 'родственника' : relativesCount < 5 ? 'родственников' : 'родственников'} за <strong>{relativesCount} SmartMatch</strong>?
          </p>
          <p className="confirm-purchase-balance">
            Текущий баланс: <strong>{smartMatchBalance}</strong> SmartMatch
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
                                  {person.birthDate || 'Не указана'}
                                </p>
                                <p className="match-detail">
                                  <MapPin size={14} />
                                  {person.birthPlace || 'Не указано'}
                                </p>
                              </div>
                            </div>

                            <div className="match-arrow">
                              <RefreshCw size={24} />
                            </div>

                            <div className="match-person found-person">
                              <h4 className="match-person-title">Дерево: {match.tree_owner}</h4>
                              <div className={`match-person-info ${!hasAccess ? 'blurred-info' : ''}`}>
                                <p className="match-name">{matchedPerson ? getFullName(matchedPerson) : 'Неизвестно'}</p>
                                <p className="match-detail">
                                  <Calendar size={14} />
                                  {matchedPerson?.birthDate || 'Не указана'}
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
                                            {relative.birthDate || 'Не указана'}
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
                                  {person.birthDate || 'Не указана'}
                                </p>
                                <p className="match-detail">
                                  <MapPin size={14} />
                                  {person.birthPlace || 'Не указано'}
                                </p>
                              </div>
                            </div>

                            <div className="match-arrow archive-arrow">
                              <RefreshCw size={24} />
                            </div>

                            <div className="match-person found-person archive-person">
                              <h4 className="match-person-title">Архив «Память народа»</h4>
                              <div className="match-person-info">
                                <p className="match-name">{archivePerson ? getFullName(archivePerson) : 'Неизвестно'}</p>
                                <p className="match-detail">
                                  <Calendar size={14} />
                                  {archivePerson?.birthDate || 'Не указана'}
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
  // Use refs for matches to ensure synchronous access
  const allTreeMatchesRef = useRef([]);
  const allArchiveMatchesRef = useRef([]);
  const [showSmartMatchingTutorial, setShowSmartMatchingTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(1);

  // Show notification as long as there are any unconfirmed matches (people with hasMatch = true)
  const showMatchFoundNotification = useMemo(() => {
    return Object.values(people).some(person => person.hasMatch);
  }, [people]);

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

  const handleAddBalance = (amount) => {
    setSmartMatchBalance(prev => prev + amount);
    showToast(`Баланс пополнен на ${amount} SmartMatch`);
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

  const handleTutorialNext = () => {
    if (tutorialStep < 3) {
      setTutorialStep(prev => prev + 1);
    } else {
      setShowSmartMatchingTutorial(false);
      setTutorialStep(1);
    }
  };

  const handleTutorialClose = () => {
    setShowSmartMatchingTutorial(false);
    setTutorialStep(1);
  };

  const sidebarNav = [
    { key: 'home', label: 'Главная', icon: Home },
    { key: 'health', label: 'Здоровье', icon: HeartPulse },
    { key: 'recommendations', label: 'Рекомендации', icon: ThumbsUp },
    { key: 'medcard', label: 'Медицинская карта', icon: FileText },
    { key: 'survey', label: 'Анкета', icon: ClipboardList },
    { key: 'origin', label: 'Происхождение', icon: Globe2 },
    { key: 'tree', label: 'Генеалогическое древо', icon: GitBranch },
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
        // Run smart matching after edit
        runSmartMatching();
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
        // Run smart matching after adding relative
        runSmartMatching();
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

  // Run smart matching
  const runSmartMatching = async () => {
    try {
      const response = await fetch(`${API_URL}/smart-matching`, {
        method: 'POST'
      });
      
      if (response.ok) {
        const data = await response.json();
        // Store all matches in refs for synchronous access when clicking the match icon
        allTreeMatchesRef.current = data.treeMatches || [];
        allArchiveMatchesRef.current = data.archiveMatches || [];
        
        await fetchPeople(); // Refresh to get updated hasMatch flags
      }
    } catch (error) {
      console.error('Smart matching error:', error);
    }
  };

  // Handle match icon click - open match modal
  const handleMatchClick = (person) => {
    setMatchPerson(person);
    // Filter stored matches for this specific person (instant, no API call)
    // Convert both to strings to avoid type mismatch
    const personId = String(person.id);
    const personTreeMatches = allTreeMatchesRef.current.filter(m => String(m.data_id) === personId);
    const personArchiveMatches = allArchiveMatchesRef.current.filter(m => String(m.data_id) === personId);
    setTreeMatches(personTreeMatches);
    setArchiveMatches(personArchiveMatches);
    setShowMatchModal(true);
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
        // Run smart matching again to find new matches
        await runSmartMatching();
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
        // Run smart matching again
        await runSmartMatching();
      }
    } catch (error) {
      console.error('Error confirming archive match:', error);
      showToast('Ошибка подтверждения', 'error');
    }
  };

  // Run smart matching on initial load and after changes
  useEffect(() => {
    if (!loading && Object.keys(people).length > 0) {
      runSmartMatching();
    }
  }, [loading]);

  // Close notifications/balance panel when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showNotifications && !e.target.closest('.notifications-wrapper')) {
        setShowNotifications(false);
      }
      if (showBalancePanel && !e.target.closest('.balance-wrapper') && !e.target.closest('.payment-modal')) {
        setShowBalancePanel(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showNotifications, showBalancePanel]);

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
            const isActive = item.key === 'tree';
            return (
              <button 
                key={item.key}
                type="button"
                className={`nav-item ${isActive ? 'active' : ''}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="main-content">
        <div className="tree-container">
          <FamilyTree 
            people={people}
            selectedPerson={selectedPerson}
            onSelectPerson={handleSelectPerson}
            onMatchClick={handleMatchClick}
            zoom={zoom}
            pan={pan}
            onPanChange={setPan}
          />
        </div>

        {/* Right Toolbar */}
        <div className="right-toolbar">
          <button className="toolbar-btn" title="Профиль">
            <User size={18} />
          </button>
          
          {/* Balance Panel */}
          <div className="balance-wrapper">
            <button 
              className="toolbar-btn" 
              title="Баланс SmartMatch"
              onClick={() => {
                setShowBalancePanel(!showBalancePanel);
                setShowNotifications(false);
              }}
            >
              <Coins size={18} />
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
            <Search size={18} />
          </button>
          <button className="toolbar-btn" title="Где я" onClick={handleCenterTree}>
            <Navigation size={18} />
          </button>
          <button className="toolbar-btn" title="Скачать">
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
      </div>

      {selectedPerson && !showEditModal && !showAddRelativeModal && (
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

      {/* SmartMatching Found Notification */}
      {showMatchFoundNotification && (
        <div 
          className="smartmatching-notification"
          onClick={handleMatchNotificationClick}
        >
          <div className="smartmatching-notification-icon">
            <RefreshCw size={20} />
          </div>
          <div className="smartmatching-notification-content">
            <p className="smartmatching-notification-title">Мы нашли ваших родственников</p>
            <p className="smartmatching-notification-subtitle">Нажмите для подробностей</p>
          </div>
        </div>
      )}

      {/* SmartMatching Tutorial Modal */}
      {showSmartMatchingTutorial && (
        <div className="modal-overlay smartmatching-tutorial-overlay" onClick={handleTutorialClose}>
          <div className="smartmatching-tutorial-modal" onClick={e => e.stopPropagation()}>
            <button className="smartmatching-tutorial-close" onClick={handleTutorialClose}>
              <X size={20} />
            </button>
            
            <div className="smartmatching-tutorial-header">
              <h3>SmartMatching</h3>
              <span className="smartmatching-tutorial-step">Шаг {tutorialStep} из 3</span>
            </div>

            <div className="smartmatching-tutorial-body">
              <div className="smartmatching-tutorial-text">
                {tutorialStep === 1 && (
                  <p>SmartMatching позволяет находить ваших родственников в деревьях других людей и архивных данных. Расширяйте ваше древо одним нажатием.</p>
                )}
                {tutorialStep === 2 && (
                  <p>Мы уделяем особое внимание защите персональных данных наших клиентов. Для добавления родственников из другого древа необходимо запросить доступ у владельца.</p>
                )}
                {tutorialStep === 3 && (
                  <p>Сейчас вам доступно добавление информации о родственниках из архивных данных. Для расширения древа за счёт ваших родственников в других деревьях необходимо оформить подписку SmartMatching.</p>
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