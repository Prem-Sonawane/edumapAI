// ============================================================
// AI Learning Planner — script.js (with share feature + imported badge + pending import fix)
// SECURE GEMINI PROXY — uses Vercel serverless function
// ============================================================

import { 
  collection, doc, getDocs, getDoc, addDoc, updateDoc, deleteDoc, 
  query, orderBy, setDoc 
} from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';

// ============================================================
// CONFIGURATION – No API key here – it's on the server
// ============================================================
const CONFIG = {
  MODEL: 'gemini-2.5-flash',
  MAX_OUTPUT_TOKENS: 32768,
  CHUNK_SIZE: 5,
  RETRY_LIMIT: 2,
  RATE_LIMIT_DELAY: 500,
  LESSON_WORDS: 500,
  DOUBT_MAX_WORDS: 150,
};

// ============================================================
// DEEPGRAM TTS ENDPOINT – replace with your actual Vercel URL
// ============================================================
const TTS_ENDPOINT = 'https://deepgram-tts-24.vercel.app/api/tts';

// ============================================================
// GLOBAL DEBUG OBJECT – to inspect TTS state from console
// ============================================================
window.ttsDebug = { lastCancel: null, lastVoice: null, lastError: null };

// ============================================================
// TTS HELPER – splits long text into chunks and plays sequentially
// ============================================================
async function playTextWithTTS(fullText, onStart, onStop, onError, voice = 'aura-asteria-en') {
  console.log('[TTS] ===== STARTING NEW PLAYBACK =====');
  console.log('[TTS] Requested voice:', voice);
  window.ttsDebug.lastVoice = voice;
  
  const MAX_CHUNK_SIZE = 1000;
  const chunks = [];

  for (let i = 0; i < fullText.length; i += MAX_CHUNK_SIZE) {
    chunks.push(fullText.substring(i, i + MAX_CHUNK_SIZE));
  }
  console.log('[TTS] Split into', chunks.length, 'chunks');

  let currentIndex = 0;
  let currentAudio = null;
  let isCancelled = false;

  const playChunk = async () => {
    if (isCancelled) {
      console.log('[TTS] Playback cancelled, stopping');
      onStop();
      return;
    }
    
    if (currentIndex >= chunks.length) {
      console.log('[TTS] All chunks played, stopping');
      onStop();
      return;
    }

    const text = chunks[currentIndex];
    const chunkNum = currentIndex + 1;
    currentIndex++;
    console.log(`[TTS] Playing chunk ${chunkNum}/${chunks.length}, length: ${text.length}`);

    try {
      console.log('[TTS] Fetching from:', TTS_ENDPOINT);
      const response = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[TTS] HTTP error', response.status, errorText);
        throw new Error(`TTS chunk failed (${response.status})`);
      }

      const audioBlob = await response.blob();
      console.log('[TTS] Received audio blob, size:', audioBlob.size);
      
      const audioUrl = URL.createObjectURL(audioBlob);
      currentAudio = new Audio(audioUrl);

      currentAudio.onended = () => {
        console.log('[TTS] Chunk finished playing');
        URL.revokeObjectURL(audioUrl);
        currentAudio = null;
        playChunk();
      };

      currentAudio.onerror = (e) => {
        console.error('[TTS] Chunk playback error', e);
        URL.revokeObjectURL(audioUrl);
        currentAudio = null;
        window.ttsDebug.lastError = e;
        onError('Audio playback failed');
        onStop();
      };

      await currentAudio.play();
      console.log('[TTS] Chunk playback started');
    } catch (e) {
      console.error('[TTS] Chunk fetch/play error:', e);
      window.ttsDebug.lastError = e;
      onError('Could not generate audio for part of the lesson.');
      onStop();
    }
  };

  console.log('[TTS] Starting first chunk');
  onStart();
  playChunk();

  const cancel = () => {
    console.log('[TTS] CANCEL FUNCTION CALLED');
    window.ttsDebug.lastCancel = new Date().toISOString();
    isCancelled = true;
    if (currentAudio) {
      console.log('[TTS] Pausing current audio');
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    onStop();
  };
  
  console.log('[TTS] Returning cancel function');
  return cancel;
}

// ============================================================
// ADVANCED JSON REPAIR (unchanged)
// ============================================================
function repairJSON(input) {
  if (typeof input !== 'string') return input;
  let str = input;
  str = str.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
  const firstBrace = str.indexOf('{');
  const firstBracket = str.indexOf('[');
  let start = -1, end = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    let depth = 0;
    for (let i = start; i < str.length; i++) {
      if (str[i] === '{') depth++;
      else if (str[i] === '}') depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  } else if (firstBracket !== -1) {
    start = firstBracket;
    let depth = 0;
    for (let i = start; i < str.length; i++) {
      if (str[i] === '[') depth++;
      else if (str[i] === ']') depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (start === -1 || end === -1) return null;
  str = str.substring(start, end);
  str = str.replace(/"((?:[^"\\]|\\.)*)"/gs, (match, inner) => {
    const escaped = inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return `"${escaped}"`;
  });
  str = str.replace(/,(\s*[}\]])/g, '$1');
  str = str.replace(/([}\]"])\s*\n\s*([{\["])/g, '$1,\n$2');
  str = str.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  const lastBrace = str.lastIndexOf('}');
  const lastBracket = str.lastIndexOf(']');
  const cutoff = Math.max(lastBrace, lastBracket);
  if (cutoff > 0) {
    str = str.substring(0, cutoff + 1);
    const openBraces = (str.match(/{/g) || []).length - (str.match(/}/g) || []).length;
    const openBrackets = (str.match(/\[/g) || []).length - (str.match(/\]/g) || []).length;
    str += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
  }
  return str;
}

// ============================================================
// DOMAIN DETECTOR (unchanged)
// ============================================================
const DomainDetector = (() => {
  const historyKeywords = ['history', 'historical', 'ancient', 'medieval', 'war', 'civilization', 'empire'];
  const literatureKeywords = ['literature', 'poetry', 'novel', 'essay', 'shakespeare', 'drama', 'fiction'];
  const techKeywords = ['programming', 'python', 'javascript', 'java', 'web', 'app', 'software', 'coding', 'developer', 'machine learning', 'ai', 'data science', 'cloud', 'devops'];
  function detect(subject) {
    const lower = subject.toLowerCase();
    if (historyKeywords.some(kw => lower.includes(kw))) return 'history';
    if (literatureKeywords.some(kw => lower.includes(kw))) return 'literature';
    if (techKeywords.some(kw => lower.includes(kw))) return 'technical';
    return 'general';
  }
  return { detect };
})();

// ============================================================
// AUTH MANAGER
// ============================================================
const AuthManager = (() => {
  let currentUser = null;
  let authInitialized = false;
  const authListeners = [];

  async function init() {
    const auth = getAuth();
    return new Promise((resolve) => {
      onAuthStateChanged(auth, (user) => {
        currentUser = user;
        authInitialized = true;
        authListeners.forEach(cb => cb(user));
        resolve(user);
      });
    });
  }

  function getUser() { return currentUser; }
  function isLoggedIn() { return currentUser !== null; }

  async function signInWithGoogle() {
    const auth = getAuth();
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      return result.user;
    } catch (error) {
      console.error('Google sign-in error:', error);
      throw error;
    }
  }

  async function signOutUser() {
    const auth = getAuth();
    await signOut(auth);
  }

  function addListener(callback) {
    authListeners.push(callback);
    if (authInitialized) callback(currentUser);
  }

  // NEW: removeListener
  function removeListener(callback) {
    const index = authListeners.indexOf(callback);
    if (index > -1) authListeners.splice(index, 1);
  }

  return { init, getUser, isLoggedIn, signInWithGoogle, signOutUser, addListener, removeListener };
})();

// ============================================================
// STORAGE MANAGER – Unified (Firestore for logged-in, localStorage for guests)
// ============================================================
const StorageManager = (() => {
  const LOCAL_STORAGE_KEY = 'learnai-courses';
  const LOCAL_STREAK_KEY = 'learnai-streak';

  function getUserId() { return AuthManager.getUser()?.uid; }

  function getLocalCourses() {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  }
  function saveLocalCourses(courses) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(courses));
  }
  function getLocalStreak() {
    const streak = localStorage.getItem(LOCAL_STREAK_KEY);
    return streak ? JSON.parse(streak) : { count: 0, lastActive: null };
  }
  function saveLocalStreak(streak) {
    localStorage.setItem(LOCAL_STREAK_KEY, JSON.stringify(streak));
  }

  async function getUserCoursesRef() {
    const uid = getUserId();
    if (!uid) throw new Error('No user logged in');
    return collection(window.db, 'users', uid, 'courses');
  }

  async function getFirestoreCourses() {
    try {
      const coursesRef = await getUserCoursesRef();
      const q = query(coursesRef, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting Firestore courses:', error);
      return [];
    }
  }

  async function addFirestoreCourse(course) {
    try {
      const coursesRef = await getUserCoursesRef();
      course.lessons = course.lessons.map(l => ({ ...l, notes: l.notes || '', doubts: l.doubts || [], quizzes: l.quizzes || [] }));
      const docRef = await addDoc(coursesRef, { ...course, createdAt: new Date().toISOString() });
      return { id: docRef.id, ...course };
    } catch (error) {
      console.error('Error adding Firestore course:', error);
      throw error;
    }
  }

  async function getFirestoreCourseById(id) {
    try {
      const coursesRef = await getUserCoursesRef();
      const docRef = doc(coursesRef, id);
      const docSnap = await getDoc(docRef);
      return docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null;
    } catch (error) {
      console.error('Error getting Firestore course:', error);
      return null;
    }
  }

  async function updateFirestoreCourse(id, updater) {
    try {
      const coursesRef = await getUserCoursesRef();
      const docRef = doc(coursesRef, id);
      const docSnap = await getDoc(docRef);
      if (!docSnap.exists()) return null;
      const current = docSnap.data();
      const updated = updater({ ...current, id });
      await updateDoc(docRef, updated);
      return { id, ...updated };
    } catch (error) {
      console.error('Error updating Firestore course:', error);
      return null;
    }
  }

  async function deleteFirestoreCourse(id) {
    try {
      const coursesRef = await getUserCoursesRef();
      const docRef = doc(coursesRef, id);
      await deleteDoc(docRef);
    } catch (error) {
      console.error('Error deleting Firestore course:', error);
    }
  }

  async function getFirestoreStreak() {
    try {
      const uid = getUserId();
      if (!uid) return null;
      const streakRef = doc(window.db, 'users', uid, 'meta', 'streak');
      const docSnap = await getDoc(streakRef);
      if (docSnap.exists()) return docSnap.data();
      const initial = { count: 0, lastActive: null };
      await setDoc(streakRef, initial);
      return initial;
    } catch (error) {
      console.error('Error getting Firestore streak:', error);
      return { count: 0, lastActive: null };
    }
  }

  async function updateFirestoreStreak() {
    try {
      const uid = getUserId();
      if (!uid) return 0;
      const today = new Date().toDateString();
      const streak = await getFirestoreStreak();
      if (streak.lastActive === today) return streak.count;
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      const newCount = (streak.lastActive === yesterday) ? streak.count + 1 : 1;
      const newStreak = { count: newCount, lastActive: today };
      const streakRef = doc(window.db, 'users', uid, 'meta', 'streak');
      await setDoc(streakRef, newStreak);
      return newCount;
    } catch (error) {
      console.error('Error updating Firestore streak:', error);
      return 0;
    }
  }

  // ========== SHARE METHODS ==========
  async function createShareLink(courseId) {
    const course = await getById(courseId);
    if (!course) throw new Error('Course not found');

    // Clean course – remove user‑specific data
    const cleanCourse = {
      subject: course.subject,
      duration: course.duration,
      unit: course.unit,
      difficulty: course.difficulty,
      totalDays: course.totalDays,
      description: course.description,
      createdAt: course.createdAt,
      lessons: course.lessons.map(l => ({
        id: l.id,
        day: l.day,
        type: l.type,
        title: l.title,
        description: l.description,
        content: l.content,
        completed: false,
        notes: '',
        doubts: [],
        quizzes: []
      }))
    };

    const shareId = generateShareId();
    const shareRef = doc(window.db, 'sharedCourses', shareId);
    await setDoc(shareRef, {
      ...cleanCourse,
      originalId: courseId,
      sharedAt: new Date().toISOString()
    });

    return `${window.location.origin}/share.html?id=${shareId}`;
  }

  async function getSharedCourse(shareId) {
    const shareRef = doc(window.db, 'sharedCourses', shareId);
    const snap = await getDoc(shareRef);
    return snap.exists() ? snap.data() : null;
  }

  function generateShareId() {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  }

  // ========== UNIFIED API (modified add to accept metadata) ==========
  async function getAll() {
    return AuthManager.isLoggedIn() ? await getFirestoreCourses() : getLocalCourses();
  }

  // MODIFIED: accept metadata and merge into course
  async function add(course, metadata = {}) {
    const courseWithMeta = { ...course, ...metadata };
    if (AuthManager.isLoggedIn()) return await addFirestoreCourse(courseWithMeta);
    const courses = getLocalCourses();
    const newCourse = { ...courseWithMeta, id: Date.now() + '-' + Math.random().toString(36).substr(2, 6) };
    courses.unshift(newCourse);
    saveLocalCourses(courses);
    return newCourse;
  }

  async function getById(id) {
    return AuthManager.isLoggedIn() ? await getFirestoreCourseById(id) : getLocalCourses().find(c => c.id === id) || null;
  }

  async function update(id, updater) {
    if (AuthManager.isLoggedIn()) return await updateFirestoreCourse(id, updater);
    const courses = getLocalCourses();
    const index = courses.findIndex(c => c.id === id);
    if (index === -1) return null;
    const updated = updater({ ...courses[index] });
    courses[index] = { ...updated, id };
    saveLocalCourses(courses);
    return courses[index];
  }

  async function remove(id) {
    if (AuthManager.isLoggedIn()) await deleteFirestoreCourse(id);
    else {
      const courses = getLocalCourses().filter(c => c.id !== id);
      saveLocalCourses(courses);
    }
  }

  async function count() {
    return AuthManager.isLoggedIn() ? (await getFirestoreCourses()).length : getLocalCourses().length;
  }

  async function saveLessonNotes(courseId, lessonId, notes) {
    return update(courseId, course => {
      const lesson = course.lessons.find(l => l.id === lessonId);
      if (lesson) lesson.notes = notes;
      return course;
    });
  }

  async function addDoubt(courseId, lessonId, doubt, answer) {
    return update(courseId, course => {
      const lesson = course.lessons.find(l => l.id === lessonId);
      if (lesson) {
        if (!lesson.doubts) lesson.doubts = [];
        lesson.doubts.push({ question: doubt, answer, timestamp: Date.now() });
      }
      return course;
    });
  }

  // UPDATED: mark completed after 2 quizzes
  async function addQuizAttempt(courseId, lessonId, score, totalQuestions) {
    return update(courseId, course => {
      const lesson = course.lessons.find(l => l.id === lessonId);
      if (lesson) {
        if (!lesson.quizzes) lesson.quizzes = [];
        lesson.quizzes.push({ date: Date.now(), score, totalQuestions });
        // Mark completed if at least 2 quizzes taken
        if (lesson.quizzes.length >= 2 && !lesson.completed) {
          lesson.completed = true;
        }
      }
      return course;
    });
  }

  async function getStreak() {
    return AuthManager.isLoggedIn() ? await getFirestoreStreak() : getLocalStreak();
  }

  async function updateStreak() {
    return AuthManager.isLoggedIn() ? await updateFirestoreStreak() : (() => {
      const today = new Date().toDateString();
      const streak = getLocalStreak();
      if (streak.lastActive === today) return streak.count;
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      const newCount = (streak.lastActive === yesterday) ? streak.count + 1 : 1;
      const newStreak = { count: newCount, lastActive: today };
      saveLocalStreak(newStreak);
      return newCount;
    })();
  }

  return {
    getAll, add, getById, update, remove, count,
    saveLessonNotes, addDoubt, addQuizAttempt,
    getStreak, updateStreak,
    createShareLink, getSharedCourse, // new
  };
})();

// ============================================================
// FALLBACK GENERATOR (minimal – replace with your own)
// ============================================================
const FallbackGenerator = (() => {
  function generateCourse({ subject, duration, unit, difficulty }) {
    const totalDays = unit === 'weeks' ? duration * 7 : unit === 'months' ? duration * 30 : duration;
    const numDays = Math.min(totalDays, 5);
    const lessons = [];
    for (let day = 1; day <= numDays; day++) {
      lessons.push({
        id: `day-${day}-${Date.now()}`,
        day,
        type: 'lesson',
        title: `Lesson ${day}: ${subject}`,
        description: `Learn about ${subject} – day ${day}`,
        content: `# Day ${day}\n\nThis is a placeholder lesson. Replace with AI content.`,
        completed: false,
        notes: '',
        doubts: [],
        quizzes: [],
      });
    }
    return {
      subject,
      duration: parseInt(duration),
      unit,
      difficulty,
      totalDays: numDays,
      description: `A ${difficulty} course on ${subject} (placeholder)`,
      createdAt: new Date().toISOString(),
      lessons,
    };
  }
  return { generateCourse };
})();
// ============================================================
// GEMINI AI CLIENT – contains full generation logic (now using proxy)
// ============================================================
const GeminiAI = (() => {
  function isConfigured() { return true; }

  // For JSON responses (courses, quizzes)
  async function callGemini(prompt, description = 'API call') {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
      }
    };
    console.log(`[GeminiAI] ${description} – sending request to proxy...`);
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[GeminiAI] HTTP error ${res.status}:`, errorText);
      throw new Error(`Gemini proxy error: ${res.status} ${errorText}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('[GeminiAI] Empty response, full data:', data);
      throw new Error('Empty response from Gemini proxy');
    }
    const repaired = repairJSON(text);
    if (!repaired) throw new Error('No JSON found in response');
    try {
      return JSON.parse(repaired);
    } catch (e) {
      console.error('[GeminiAI] JSON parse failed after repair', e, 'Repaired string start:', repaired.substring(0, 500));
      throw new Error('Invalid JSON after repair');
    }
  }

  // For raw text responses (doubt answers)
  async function callGeminiRaw(prompt, description = 'API call') {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1000,
      }
    };
    console.log(`[GeminiAI] ${description} – sending raw request to proxy...`);
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Gemini proxy error: ${res.status} - ${errorText}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`Gemini API error: ${data.error.message}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini proxy');
    return text.trim();
  }

  async function generateCourse({ subject, duration, unit, difficulty }) {
    console.log('[GeminiAI] Starting course generation', { subject, duration, unit, difficulty });
    const totalDays = unit === 'weeks' ? duration * 7 : unit === 'months' ? duration * 30 : duration;
    const numDays = totalDays;
    const domain = DomainDetector.detect(subject);
    console.log('[GeminiAI] Generating day titles...');
    const titlePrompt = `Create a list of ${numDays} lesson titles for a "${difficulty}" level course on "${subject}" lasting ${numDays} days. Return a JSON array of strings. The titles should follow a logical progression.`;
    let titles;
    try {
      const titleData = await callGemini(titlePrompt, 'Generating titles');
      if (Array.isArray(titleData)) titles = titleData;
      else throw new Error('Titles not array');
    } catch (e) {
      console.warn('Title generation failed, using fallback', e);
      titles = [];
      for (let i = 1; i <= numDays; i++) {
        if (i === 1) titles.push(`Introduction to ${subject}`);
        else if (i === 2) titles.push(`Core Principles of ${subject}`);
        else if (i === 3) titles.push(`Fundamental Concepts in ${subject}`);
        else if (i === 4) titles.push(`Essential Techniques for ${subject}`);
        else if (i === 5) titles.push(`Hands‑on Practice with ${subject}`);
        else if (i === 6) titles.push(`Intermediate ${subject} Skills`);
        else if (i === 7) titles.push(`Deep Dive into ${subject}`);
        else titles.push(`Advanced Topics in ${subject} (Part ${i-7})`);
      }
    }
    while (titles.length < numDays) titles.push(`Day ${titles.length + 1}: Further Study in ${subject}`);

    const allLessons = [];
    for (let start = 1; start <= numDays; start += CONFIG.CHUNK_SIZE) {
      const end = Math.min(start + CONFIG.CHUNK_SIZE - 1, numDays);
      console.log(`[GeminiAI] Generating chunk for days ${start}–${end}...`);
      const chunkTitles = titles.slice(start - 1, end);
      const chunkOutline = chunkTitles.map((t, idx) => `Day ${start + idx}: "${t}"`).join('\n');
      let domainInstructions = '';
      if (domain === 'history') {
        domainInstructions = `- Include references to key historical figures, events, and primary sources.\n- Suggest books, documentaries, or movies at the end of relevant lessons.\n- Make the content engaging and narrative‑driven.`;
      } else if (domain === 'literature') {
        domainInstructions = `- Include analysis of themes, characters, and literary devices.\n- Suggest reading passages or excerpts.\n- Encourage critical thinking and interpretation.`;
      } else if (domain === 'technical') {
        domainInstructions = `- Include code examples, syntax explanations, and practical exercises.\n- On every 3rd day, include a hands‑on project idea (but do not generate quiz).\n- At the end, include a final project description with a problem statement.`;
      } else {
        domainInstructions = `- Provide clear explanations and real‑world examples.\n- Include exercises for practice.`;
      }
      const chunkPrompt = `You are an expert curriculum designer. Create detailed content for days ${start} to ${end} of a "${difficulty}" level course on "${subject}".

**Domain‑specific instructions:**
${domainInstructions}

For each day, provide ONLY a lesson (target ${CONFIG.LESSON_WORDS} words) with explanations, examples, and exercises. Do NOT include quizzes or projects in this output – they will be generated later on‑demand.

Use these titles:
${chunkOutline}

Return a JSON object with a single key "lessons" containing an array of lesson objects. Each lesson object must have:
- "id": a unique string (e.g., "day-5-lesson")
- "day": the day number
- "type": "lesson"
- "title": the lesson title
- "description": a short description
- "content": the full lesson content (as a string, with markdown allowed)
- "completed": false (will be updated later)
- "notes": "" (empty string)
- "doubts": [] (empty array)
- "quizzes": [] (empty array)

**Important:** 
- Return ONLY valid JSON. No markdown, no extra text.
- Escape all newlines inside string values as \\n.
- Ensure every day from ${start} to ${end} is included.`;

      let chunkLessons = null;
      let success = false;
      for (let attempt = 0; attempt < CONFIG.RETRY_LIMIT; attempt++) {
        try {
          const data = await callGemini(chunkPrompt, `Chunk ${start}-${end} (attempt ${attempt+1})`);
          if (data.lessons && Array.isArray(data.lessons)) {
            chunkLessons = data.lessons;
            success = true;
            break;
          }
        } catch (e) {
          console.warn(`Chunk ${start}-${end} attempt ${attempt+1} failed`, e);
        }
      }
      if (!success) {
        console.warn(`Chunk ${start}-${end} failed, using fallback lessons`);
        chunkLessons = chunkTitles.map((title, idx) => ({
          id: `day-${start + idx}-lesson-fallback-${Date.now()}`,
          day: start + idx,
          type: 'lesson',
          title,
          description: `Lesson for day ${start + idx}.`,
          content: `# ${title}\n\nThis lesson could not be generated by AI. Please try again later.`,
          completed: false,
          notes: '',
          doubts: [],
          quizzes: [],
        }));
      }
      allLessons.push(...chunkLessons);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY));
    }
    allLessons.sort((a, b) => a.day - b.day);
    return {
      subject: subject.trim(),
      duration: parseInt(duration, 10),
      unit,
      difficulty,
      totalDays: numDays,
      description: `A ${difficulty} course on ${subject} spanning ${duration} ${unit}.`,
      createdAt: new Date().toISOString(),
      lessons: allLessons,
    };
  }

   async function askDoubt(lessonContent, question) {
    const prompt = `You are a helpful tutor. Answer the following question about the lesson below. Provide a complete, detailed answer. Do not stop mid-sentence. Your answer should be helpful and thorough, and you must finish the answer completely. Take your time to write a full response. Use as many words as needed.

Lesson content:
${lessonContent}

Question: ${question}

Answer:`;
    try {
      const answer = await callGeminiRaw(prompt, 'Ask doubt');
      return answer;
    } catch (e) {
      console.error('Doubt API failed', e);
      return 'Sorry, I could not answer your doubt at the moment. Please try again later.';
    }
  }

  async function generateQuiz(lessonContent, numQuestions) {
    const prompt = `You are an expert quiz creator. Based on the following lesson, generate a quiz with exactly ${numQuestions} multiple‑choice questions. The questions should test understanding of the key concepts.

Lesson content:
${lessonContent}

Return a JSON object with a single key "questions" containing an array of question objects. Each question object must have:
- "id": a unique string (e.g., "q1")
- "question": the question text
- "options": an array of 4 strings
- "correct": the index of the correct option (0‑3)
- "explanation": a brief explanation of the correct answer

**Important:** Return ONLY valid JSON. No extra text.`;
    try {
      const data = await callGemini(prompt, 'Generate quiz');
      if (data.questions && Array.isArray(data.questions)) return data.questions;
      throw new Error('Invalid quiz structure');
    } catch (e) {
      console.error('Quiz generation failed', e);
      const fallback = [];
      for (let i = 0; i < numQuestions; i++) {
        fallback.push({
          id: `q${i}`,
          question: `Sample question ${i+1}?`,
          options: ['A', 'B', 'C', 'D'],
          correct: 0,
          explanation: 'This is a fallback question.',
        });
      }
      return fallback;
    }
  }

  return { isConfigured, generateCourse, askDoubt, generateQuiz };
})();

// ============================================================
// THEME MANAGER (unchanged)
// ============================================================
const ThemeManager = (() => {
  const STORAGE_KEY = 'learnai-theme';
  const html = document.documentElement;
  function getCurrentTheme() { return localStorage.getItem(STORAGE_KEY) || 'dark'; }
  function setTheme(theme) {
    html.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
    updateToggleButton(theme);
  }
  function toggleTheme() {
    const current = getCurrentTheme();
    setTheme(current === 'dark' ? 'light' : 'dark');
  }
  function updateToggleButton(theme) {
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.innerHTML = theme === 'dark' ? '☀️' : '🌙';
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }
  function init() {
    if (!document.getElementById('theme-toggle')) {
      const navbarActions = document.querySelector('.navbar__actions');
      if (navbarActions) {
        const btn = document.createElement('button');
        btn.id = 'theme-toggle';
        btn.className = 'theme-toggle';
        btn.setAttribute('aria-label', 'Toggle theme');
        btn.onclick = toggleTheme;
        navbarActions.prepend(btn);
      }
    }
    setTheme(getCurrentTheme());
  }
  return { init };
})();

// ============================================================
// COURSE ENGINE (unchanged)
// ============================================================
const CourseEngine = (() => {
  function toDays(n, unit) {
    const num = parseInt(n, 10) || 1;
    return unit === 'weeks' ? num * 7 : unit === 'months' ? num * 30 : num;
  }
  function validate(subject, duration) {
    const errors = {};
    if (!subject || subject.trim().length < 2) errors.subject = 'Please enter a subject (min. 2 characters).';
    if (subject.trim().length > 120) errors.subject = 'Subject must be 120 characters or fewer.';
    const d = parseInt(duration, 10);
    if (!duration || isNaN(d) || d < 1) errors.duration = 'Duration must be at least 1.';
    if (d > 365) errors.duration = 'Duration cannot exceed 365.';
    return errors;
  }
  return { toDays, validate };
})();

// ============================================================
// PROGRESS CALCULATOR (unchanged)
// ============================================================
const ProgressCalc = (() => {
  function completionPercent(course) {
    const lessons = course.lessons || [];
    if (!lessons.length) return 0;
    const completed = lessons.filter(l => l.completed).length;
    return Math.round((completed / lessons.length) * 100);
  }
  function daysRemaining(course) {
    const start = new Date(course.createdAt);
    const deadline = new Date(start.getTime() + course.totalDays * 86400000);
    const diff = deadline - Date.now();
    const remaining = Math.ceil(diff / 86400000);
    return remaining > 0 ? remaining : 0;
  }
  function daysRemainingLabel(course) {
    const d = daysRemaining(course);
    return d === 0 ? 'Deadline passed' : d === 1 ? '1 day left' : `${d} days left`;
  }
  function stats(course) {
    const p = completionPercent(course);
    const total = course.lessons.length;
    const completed = course.lessons.filter(l => l.completed).length;
    return { pct: p, completed, remaining: total - completed, total, daysLeft: daysRemaining(course), daysLabel: daysRemainingLabel(course) };
  }
  return { completionPercent, daysRemaining, daysRemainingLabel, stats };
})();

// ============================================================
// UI RENDERER – includes full lesson modal, quiz modal, doubt modal (with chunked TTS)
// ============================================================
const UIRenderer = (() => {
  const $ = id => document.getElementById(id);
  let toastTimer;
  function toast(msg, type = 'default', dur = 3000) {
    const el = $('toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.className = `toast toast--${type} is-visible`;
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), dur);
  }
  function showFieldError(id, msg) {
    const err = $(id + '-error');
    const inp = $(id);
    if (err) err.textContent = msg;
    if (inp) inp.classList.add('is-error');
  }
  function clearFieldErrors() {
    document.querySelectorAll('.field__input.is-error').forEach(e => e.classList.remove('is-error'));
    document.querySelectorAll('.field__error').forEach(e => e.textContent = '');
  }
  function selectSegment(btn, fieldId) {
    btn.closest('.field__segment').querySelectorAll('.segment__btn').forEach(b => b.classList.remove('segment__btn--active'));
    btn.classList.add('segment__btn--active');
    $(fieldId).value = btn.dataset.value;
  }
  function setGenerateLoading(on) {
    const btn = $('generate-btn');
    const status = $('api-status');
    if (btn) {
      btn.classList.toggle('is-loading', on);
      btn.disabled = on;
    }
    if (status) {
      status.className = `navbar__status${on ? ' is-loading' : ''}`;
      const label = status.querySelector('.status__label');
      if (label) label.textContent = on ? 'Generating…' : 'AI Ready';
    }
  }
  function setSaveLoading(on) {
    const btn = $('save-btn');
    if (btn) {
      btn.classList.toggle('is-loading', on);
      btn.disabled = on;
    }
  }
  async function updateNavCount() {
    const count = await StorageManager.count();
    const el = $('nav-course-count');
    if (el) el.textContent = count > 0 ? count : '';
  }
  async function updateStreakDisplay() {
    const streak = await StorageManager.getStreak();
    let streakEl = document.getElementById('streak-display');
    if (!streakEl) return;
    streakEl.innerHTML = `🔥 ${streak.count} day${streak.count !== 1 ? 's' : ''}`;
  }
  function renderResultCard(course) {
    $('result-title').textContent = `${course.subject} Roadmap`;
    $('result-duration-badge').textContent = `${course.duration} ${course.unit}`;
    $('result-desc').textContent = course.description;
    const totalLessons = course.lessons.length;
    $('result-stats').innerHTML = `
      <div class="stat-pill">📚 ${totalLessons} lessons</div>
      <div class="stat-pill">⏱ ${course.duration} ${course.unit}</div>
      <div class="stat-pill">🎯 ${course.difficulty}</div>
      ${GeminiAI.isConfigured() ? '<div class="stat-pill stat-pill--ai">✦ Gemini Generated</div>' : ''}
    `;
    const preview = $('lessons-preview');
    preview.innerHTML = course.lessons.slice(0, 5).map((l, i) => `
      <div class="lesson-preview__item" style="animation-delay:${i*55}ms">
        <span class="lesson-preview__num">📘</span>
        <span>${escapeHtml(l.title)}</span>
      </div>
    `).join('');
    if (course.lessons.length > 5) {
      preview.insertAdjacentHTML('beforeend', `<div class="lesson-preview__item lesson-preview__more"><span class="lesson-preview__num">+</span><span>…and ${course.lessons.length-5} more</span></div>`);
    }
    $('result-card').hidden = false;
    $('result-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hideResultCard() {
    $('result-card').hidden = true;
  }

  // MODIFIED: renderLibrary – added share button and imported badge
  async function renderLibrary(courses, filter = '') {
    const grid = $('library-grid');
    const empty = $('library-empty');
    const toolbar = $('library-toolbar');
    const meta = $('library-meta');
    const filtered = filter ? courses.filter(c => c.subject.toLowerCase().includes(filter.toLowerCase())) : courses;
    const isEmpty = courses.length === 0;
    if (empty) empty.classList.toggle('hidden', !isEmpty);
    if (toolbar) toolbar.classList.toggle('hidden', isEmpty);
    if (grid) grid.classList.toggle('hidden', isEmpty);
    if (isEmpty) return;
    if (meta) meta.textContent = filter ? `${filtered.length} of ${courses.length} courses` : `${courses.length} course${courses.length !== 1 ? 's' : ''}`;
    grid.innerHTML = '';
    if (!filtered.length) {
      grid.innerHTML = `<p style="color:var(--color-text-muted)">No courses matching "${escapeHtml(filter)}"</p>`;
      return;
    }
    filtered.forEach((course, idx) => {
      const pct = ProgressCalc.completionPercent(course);
      const days = ProgressCalc.daysRemainingLabel(course);
      const card = document.createElement('div');
      card.className = 'course-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.style.animationDelay = `${idx * 50}ms`;
      // Add imported badge if course.importedFrom exists
      const importedBadge = course.importedFrom ? '<span class="chip chip--violet">IMPORTED</span>' : '';
      card.innerHTML = `
        <div class="course-card__header">
          <span class="course-card__difficulty">${escapeHtml(course.difficulty)}</span>
          ${importedBadge}
          <span class="chip chip--amber">${escapeHtml(days)}</span>
        </div>
        <div class="course-card__title">${escapeHtml(course.subject)}</div>
        <div class="course-card__meta">
          <span>${course.lessons.length} lessons</span><span class="course-card__dot"></span>
          <span>${course.duration} ${course.unit}</span>
        </div>
        <div style="margin-top:auto">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:var(--text-xs);color:var(--color-text-muted)">Progress</span>
            <span style="font-size:var(--text-xs);font-weight:700;color:var(--color-violet-400)">${pct}%</span>
          </div>
          <div class="card-progress__bar"><div class="card-progress__fill" style="width:${pct}%"></div></div>
        </div>
        <div class="course-card__actions">
          <button class="course-card__action-btn" data-action="export" title="Export as JSON">⬇️</button>
          <button class="course-card__action-btn" data-action="duplicate" title="Duplicate course">📋</button>
          <button class="course-card__action-btn" data-action="share" title="Share course">🔗</button>
          <button class="course-card__action-btn" data-action="delete" title="Delete course">🗑️</button>
        </div>`;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.course-card__action-btn')) return;
        App.openDashboard(course.id);
      });
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') App.openDashboard(course.id); });
      card.querySelectorAll('.course-card__action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          if (action === 'export') App.exportCourse(course.id);
          else if (action === 'duplicate') App.duplicateCourse(course.id);
          else if (action === 'share') App.shareCourse(course.id);
          else if (action === 'delete') App.deleteCourse(course.id);
        });
      });
      grid.appendChild(card);
    });
  }

  function renderLibraryLoading() {
    $('library-grid').innerHTML = Array(3).fill(0).map(() => '<div class="skeleton" style="height:180px;border-radius:var(--radius-lg)"></div>').join('');
  }

  async function filterLibrary() {
    const courses = await StorageManager.getAll();
    renderLibrary(courses, $('library-search')?.value || '');
  }

  // MODIFIED: renderDashboard – added share button in header
  async function renderDashboard(course) {
    const s = ProgressCalc.stats(course);
    $('dashboard-title').textContent = course.subject;
    $('dashboard-meta').textContent = `${course.lessons.length} lessons · ${course.duration} ${course.unit} · ${course.difficulty}`;
    $('dashboard-stats').innerHTML = `
      <div class="stat-card"><div class="stat-card__value">${s.completed}</div><div class="stat-card__label">Completed</div></div>
      <div class="stat-card"><div class="stat-card__value">${s.remaining}</div><div class="stat-card__label">Remaining</div></div>
      <div class="stat-card"><div class="stat-card__value">${s.total}</div><div class="stat-card__label">Total</div></div>
      <div class="stat-card"><div class="stat-card__value">${s.daysLeft}</div><div class="stat-card__label">Days Left</div></div>
    `;
    $('dashboard-pct').textContent = `${s.pct}%`;
    $('dashboard-bar').style.width = `${s.pct}%`;
    const circumference = 175.929;
    $('ring-fill').style.strokeDashoffset = circumference - (s.pct / 100) * circumference;
    $('ring-label').textContent = `${s.pct}%`;
    const list = $('dashboard-lessons');
    list.innerHTML = '';
    const lessonsByDay = course.lessons.reduce((acc, lesson) => {
      const day = lesson.day || 1;
      if (!acc[day]) acc[day] = [];
      acc[day].push(lesson);
      return acc;
    }, {});
    const sortedDays = Object.keys(lessonsByDay).sort((a, b) => a - b);
    sortedDays.forEach(day => {
      const dayHeader = document.createElement('div');
      dayHeader.className = 'day-header';
      dayHeader.innerHTML = `<h4>Day ${day}</h4>`;
      list.appendChild(dayHeader);
      lessonsByDay[day].forEach((lesson, idx) => {
        const item = document.createElement('div');
        item.className = `lesson-item ${lesson.completed ? 'is-complete' : ''}`;
        item.dataset.lessonId = lesson.id;
        item.style.animationDelay = `${idx * 40}ms`;
        const icon = '📘';
        const typeLabel = 'Lesson';
        let actionsHtml = `
          <span class="lesson-item__tag ${lesson.completed ? 'lesson-item__tag--done' : 'lesson-item__tag--pending'}">
            ${lesson.completed ? 'Done' : 'Pending'}
          </span>
        `;
        // Checkbox is now static (no click handler)
        const checkDiv = document.createElement('div');
        checkDiv.className = 'lesson-item__check';
        if (lesson.completed) {
          checkDiv.classList.add('is-complete');
          checkDiv.innerHTML = '<span class="lesson-item__check-icon">✓</span>';
        } else {
          checkDiv.innerHTML = '';
        }
        // No event listeners on checkDiv
        const contentDiv = document.createElement('div');
        contentDiv.className = 'lesson-item__content';
        contentDiv.innerHTML = `
          <div class="lesson-item__title">${icon} ${escapeHtml(lesson.title)}</div>
          <div class="lesson-item__module">${typeLabel} · ${escapeHtml(lesson.description || '')}</div>
        `;
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'lesson-item__actions';
        actionsDiv.innerHTML = actionsHtml;
        item.appendChild(checkDiv);
        item.appendChild(contentDiv);
        item.appendChild(actionsDiv);
        // Content click still opens lesson
        contentDiv.addEventListener('click', (e) => {
          App.openLesson(course, lesson);
        });
        list.appendChild(item);
      });
    });

    // Delete button
    const deleteBtn = document.getElementById('dashboard-delete-btn');
    if (deleteBtn) {
      deleteBtn.replaceWith(deleteBtn.cloneNode(true));
      document.getElementById('dashboard-delete-btn').addEventListener('click', () => {
        App.deleteCourse(course.id);
      });
    }

    // NEW: Share button in dashboard header
    const shareBtn = document.getElementById('dashboard-share-btn');
    if (shareBtn) {
      shareBtn.replaceWith(shareBtn.cloneNode(true));
      document.getElementById('dashboard-share-btn').addEventListener('click', () => {
        App.shareCourse(course.id);
      });
    }

    // Final Report button – show only if all lessons completed
    const reportBtn = document.getElementById('dashboard-report-btn');
    if (reportBtn) {
      const allCompleted = course.lessons.every(l => l.completed);
      reportBtn.style.display = allCompleted ? 'inline-flex' : 'none';

      // Remove old listener and attach new one
      reportBtn.replaceWith(reportBtn.cloneNode(true));
      const newReportBtn = document.getElementById('dashboard-report-btn');
      if (newReportBtn) {
        newReportBtn.addEventListener('click', () => {
          App.generateReport(course.id);
        });
      }
    }
  }

  // ---------- FULL LESSON MODAL with async refresh and chunked TTS ----------
  function showLessonModal(course, lesson) {
    document.getElementById('lesson-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'lesson-modal';
    modal.className = 'lesson-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    // Build library items from lesson data
    const doubtItems = (lesson.doubts || []).map(d => `
      <div class="library-item doubt-item" data-question="${escapeHtml(d.question)}" data-answer="${escapeHtml(d.answer)}">
        <div class="doubt-question">Q: ${escapeHtml(d.question)}</div>
        <div class="item-date">${new Date(d.timestamp).toLocaleString()}</div>
      </div>
    `).join('');

    const quizItems = (lesson.quizzes || []).map(q => `
      <div class="library-item">
        <div class="quiz-score">Score: ${q.score}/${q.totalQuestions}</div>
        <div class="item-date">${new Date(q.date).toLocaleDateString()}</div>
      </div>
    `).join('');

    const notesItem = lesson.notes ? `
      <div class="library-item">
        <div class="notes-content">${escapeHtml(lesson.notes)}</div>
        <div class="item-date">Saved</div>
      </div>
    ` : '';

    modal.innerHTML = `
      <div class="lesson-modal__backdrop"></div>
      <div class="lesson-modal__box card">
        <div class="lesson-modal__header">
          <h3 class="lesson-modal__title">${escapeHtml(lesson.title)}</h3>
          <div class="lesson-modal__header-actions">
            <button class="icon-btn" id="listen-lesson-btn" title="Listen to lesson">🔊</button>
            <button class="icon-btn" id="lesson-close-btn" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13"/></svg>
            </button>
          </div>
        </div>

        <div class="lesson-content-section">
          <div class="lesson-modal__body" id="lesson-content">
            ${window.marked ? marked.parse(lesson.content) : `<pre>${escapeHtml(lesson.content)}</pre>`}
          </div>
        </div>

        <div class="action-cards">
          <div class="action-card" id="doubt-card">
            <h4 class="card-title">Ask a Doubt</h4>
            <p class="card-description">Get instant clarification from AI.</p>
            <textarea id="doubt-question" class="card-input" placeholder="Type your doubt here..." rows="2"></textarea>
            <div class="card-actions">
              <button class="btn btn--primary btn--sm" id="ask-doubt-btn">Ask</button>
              <span id="doubt-loading" class="loading-indicator" style="display:none;">Processing...</span>
            </div>
          </div>

          <div class="action-card" id="quiz-card">
            <h4 class="card-title">Take a Quiz</h4>
            <p class="card-description">Test your knowledge with a quiz.</p>
            <div class="quiz-options">
              <label><input type="radio" name="qcount" value="10" checked> 10 questions</label>
              <label><input type="radio" name="qcount" value="15"> 15 questions</label>
              <label><input type="radio" name="qcount" value="20"> 20 questions</label>
            </div>
            <div class="card-actions">
              <button class="btn btn--primary btn--sm" id="generate-quiz-btn">Generate Quiz</button>
              <span id="quiz-loading" class="loading-indicator" style="display:none;">Generating...</span>
            </div>
          </div>

          <div class="action-card" id="notes-card">
            <h4 class="card-title">Add Notes</h4>
            <p class="card-description">Write your personal notes for this lesson.</p>
            <textarea id="lesson-notes" class="card-input" placeholder="Write your notes here..." rows="3">${escapeHtml(lesson.notes || '')}</textarea>
            <div class="card-actions">
              <button class="btn btn--primary btn--sm" id="save-notes-btn">Save Notes</button>
              <span id="notes-saved-message" class="saved-indicator" style="display:none;">✓ Saved</span>
            </div>
          </div>
        </div>

        <div class="lesson-library">
          <h4 class="library-title">Lesson Library</h4>
          <div class="library-tabs">
            <button class="tab-btn active" data-tab="doubts">Doubts</button>
            <button class="tab-btn" data-tab="quizzes">Quizzes</button>
            <button class="tab-btn" data-tab="notes">Notes</button>
          </div>
          <div class="library-panes">
            <div class="tab-pane active" id="doubts-pane">
              ${doubtItems || '<p class="empty-message">No doubts yet.</p>'}
            </div>
            <div class="tab-pane" id="quizzes-pane">
              ${quizItems || '<p class="empty-message">No quizzes taken yet.</p>'}
            </div>
            <div class="tab-pane" id="notes-pane">
              ${notesItem || '<p class="empty-message">No notes saved yet.</p>'}
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));

    // Async refresh library function
    const refreshLibrary = async () => {
      const updatedCourse = await StorageManager.getById(course.id);
      if (!updatedCourse) return;
      const updatedLesson = updatedCourse.lessons.find(l => l.id === lesson.id);
      if (!updatedLesson) return;

      const doubtsPane = modal.querySelector('#doubts-pane');
      doubtsPane.innerHTML = (updatedLesson.doubts || []).map(d => `
        <div class="library-item doubt-item" data-question="${escapeHtml(d.question)}" data-answer="${escapeHtml(d.answer)}">
          <div class="doubt-question">Q: ${escapeHtml(d.question)}</div>
          <div class="item-date">${new Date(d.timestamp).toLocaleString()}</div>
        </div>
      `).join('') || '<p class="empty-message">No doubts yet.</p>';

      doubtsPane.querySelectorAll('.doubt-item').forEach(item => {
        item.addEventListener('click', () => {
          const question = item.dataset.question;
          const answer = item.dataset.answer;
          showDoubtDetailModal(question, answer);
        });
      });

      const quizzesPane = modal.querySelector('#quizzes-pane');
      quizzesPane.innerHTML = (updatedLesson.quizzes || []).map(q => `
        <div class="library-item">
          <div class="quiz-score">Score: ${q.score}/${q.totalQuestions}</div>
          <div class="item-date">${new Date(q.date).toLocaleDateString()}</div>
        </div>
      `).join('') || '<p class="empty-message">No quizzes taken yet.</p>';

      const notesPane = modal.querySelector('#notes-pane');
      notesPane.innerHTML = updatedLesson.notes ? `
        <div class="library-item">
          <div class="notes-content">${escapeHtml(updatedLesson.notes)}</div>
          <div class="item-date">Saved</div>
        </div>
      ` : '<p class="empty-message">No notes saved yet.</p>';
    };

    // Listen for quiz-saved event to refresh library
    modal.addEventListener('quiz-saved', refreshLibrary);

    // Tab switching
    const tabButtons = modal.querySelectorAll('.tab-btn');
    const panes = modal.querySelectorAll('.tab-pane');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        panes.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const tabId = btn.dataset.tab + '-pane';
        modal.querySelector('#' + tabId).classList.add('active');
      });
    });

    // Close modal
    const closeModal = () => {
      if (cancelTTS) cancelTTS(); // stop any ongoing TTS
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 300);
    };
    modal.querySelector('.lesson-modal__backdrop').addEventListener('click', closeModal);
    modal.querySelector('#lesson-close-btn').addEventListener('click', closeModal);

    // ----- Audio playback with chunked Deepgram TTS -----
    const listenBtn = modal.querySelector('#listen-lesson-btn');
    let cancelTTS = null;
    let isPlaying = false;

    listenBtn.addEventListener('click', () => {
      console.log('[UI] Listen button clicked, isPlaying:', isPlaying);
      
      if (isPlaying) {
        console.log('[UI] Stopping current playback');
        if (typeof cancelTTS === 'function') {
          console.log('[UI] Calling cancelTTS function');
          cancelTTS();
          cancelTTS = null;
        }
        isPlaying = false;
        listenBtn.innerHTML = '🔊';
        listenBtn.title = 'Listen to lesson';
        return;
      }

      const contentDiv = modal.querySelector('#lesson-content');
      const fullText = contentDiv.innerText || contentDiv.textContent;
      console.log('[UI] Starting playback, text length:', fullText.length);

      listenBtn.innerHTML = '⏳';
      listenBtn.disabled = true;

      console.log('[UI] Calling playTextWithTTS');
      const cancelPromise = playTextWithTTS(
        fullText,
        () => {
          // onStart
          console.log('[UI] TTS onStart called');
          isPlaying = true;
          listenBtn.innerHTML = '⏸️';
          listenBtn.title = 'Stop';
          listenBtn.disabled = false;
        },
        () => {
          // onStop
          console.log('[UI] TTS onStop called');
          isPlaying = false;
          listenBtn.innerHTML = '🔊';
          listenBtn.title = 'Listen to lesson';
          listenBtn.disabled = false;
          cancelTTS = null;
        },
        (errorMsg) => {
          // onError
          console.log('[UI] TTS onError:', errorMsg);
          UIRenderer.toast(errorMsg, 'error');
          isPlaying = false;
          listenBtn.innerHTML = '🔊';
          listenBtn.title = 'Listen to lesson';
          listenBtn.disabled = false;
          cancelTTS = null;
        }
      );
      
      cancelPromise.then(cancel => {
        cancelTTS = cancel;
        console.log('[UI] cancelTTS stored:', typeof cancelTTS);
      }).catch(err => {
        console.error('[UI] Failed to get cancel function:', err);
        UIRenderer.toast('Could not initialize TTS', 'error');
        listenBtn.innerHTML = '🔊';
        listenBtn.disabled = false;
      });
    });

    // Ask Doubt
    const askBtn = modal.querySelector('#ask-doubt-btn');
    const doubtInput = modal.querySelector('#doubt-question');
    const doubtLoading = modal.querySelector('#doubt-loading');
    askBtn.addEventListener('click', async () => {
      const question = doubtInput.value.trim();
      if (!question) {
        UIRenderer.toast('Please enter a question.', 'error');
        return;
      }
      doubtInput.disabled = true;
      askBtn.disabled = true;
      doubtLoading.style.display = 'inline';

      try {
        const answer = await GeminiAI.askDoubt(lesson.content, question);
        await StorageManager.addDoubt(course.id, lesson.id, question, answer);
        doubtInput.value = '';
        await refreshLibrary();
        UIRenderer.toast('Doubt answered! Check the Library.', 'success');
      } catch (e) {
        UIRenderer.toast('Failed to get answer. Try again.', 'error');
      } finally {
        doubtLoading.style.display = 'none';
        doubtInput.disabled = false;
        askBtn.disabled = false;
      }
    });

    // Save Notes
    const saveNotesBtn = modal.querySelector('#save-notes-btn');
    const notesTextarea = modal.querySelector('#lesson-notes');
    const notesSaved = modal.querySelector('#notes-saved-message');
    saveNotesBtn.addEventListener('click', async () => {
      const notes = notesTextarea.value;
      await StorageManager.saveLessonNotes(course.id, lesson.id, notes);
      notesSaved.style.display = 'inline';
      await refreshLibrary();
      setTimeout(() => { notesSaved.style.display = 'none'; }, 2000);
    });

    // Generate Quiz
    const generateQuizBtn = modal.querySelector('#generate-quiz-btn');
    const quizOptions = modal.querySelectorAll('input[name="qcount"]');
    generateQuizBtn.addEventListener('click', () => {
      const selected = Array.from(quizOptions).find(r => r.checked);
      const num = selected ? parseInt(selected.value) : 10;
      showQuizModal(course, lesson, num);
    });

    // Initial doubt click listeners
    const doubtsPane = modal.querySelector('#doubts-pane');
    doubtsPane.querySelectorAll('.doubt-item').forEach(item => {
      item.addEventListener('click', () => {
        const question = item.dataset.question;
        const answer = item.dataset.answer;
        showDoubtDetailModal(question, answer);
      });
    });

    const onEsc = e => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
  }

  function closeLessonModal() {
    const modal = document.getElementById('lesson-modal');
    if (modal) {
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 300);
    }
  }

  // Quiz Modal (unchanged, but now uses updated addQuizAttempt)
  async function showQuizModal(course, lesson, numQuestions) {
    document.getElementById('quiz-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'quiz-modal';
    modal.className = 'quiz-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="quiz-modal__backdrop"></div>
      <div class="quiz-modal__box card">
        <div class="quiz-modal__header">
          <h3 class="quiz-modal__title">Quiz: ${escapeHtml(lesson.title)}</h3>
          <button class="icon-btn" id="quiz-close-btn" aria-label="Close quiz"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1l12 12M13 1L1 13"/></svg></button>
        </div>
        <div class="quiz-modal__body" id="quiz-body">
          <div class="quiz-loading">Generating questions...</div>
        </div>
        <div class="quiz-footer">
          <div id="quiz-score"></div>
          <button class="btn btn--primary" id="quiz-submit-btn" disabled>Submit Answers</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));

    const closeModal = () => {
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 300);
    };
    modal.querySelector('.quiz-modal__backdrop').addEventListener('click', closeModal);
    modal.querySelector('#quiz-close-btn').addEventListener('click', closeModal);
    const onEsc = e => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);

    const questions = await GeminiAI.generateQuiz(lesson.content, numQuestions);
    const quizBody = modal.querySelector('#quiz-body');
    quizBody.innerHTML = questions.map((q, i) => `
      <div class="quiz-question" data-qid="${q.id}">
        <p class="quiz-question__text">${escapeHtml(q.question)}</p>
        <div class="quiz-options">
          ${q.options.map((opt, oi) => `
            <label class="quiz-option">
              <input type="radio" name="q${i}" value="${oi}" class="quiz-option__radio" />
              <span class="quiz-option__letter">${String.fromCharCode(65 + oi)}</span>
              <span class="quiz-option__text">${escapeHtml(opt)}</span>
            </label>
          `).join('')}
        </div>
        <div class="quiz-explanation" hidden></div>
      </div>
    `).join('');
    const submitBtn = modal.querySelector('#quiz-submit-btn');
    submitBtn.disabled = false;
    submitBtn.addEventListener('click', async () => {
      let correct = 0;
      questions.forEach((q, i) => {
        const selected = document.querySelector(`input[name="q${i}"]:checked`);
        const answer = selected ? parseInt(selected.value) : -1;
        const isCorrect = answer === q.correct;
        if (isCorrect) correct++;
        const questionDiv = document.querySelector(`[data-qid="${q.id}"]`);
        const options = questionDiv.querySelectorAll('.quiz-option');
        options.forEach((opt, oi) => {
          const radio = opt.querySelector('input');
          radio.disabled = true;
          if (oi === q.correct) opt.classList.add('quiz-option--correct');
          else if (oi === answer) opt.classList.add('quiz-option--wrong');
        });
        const expDiv = questionDiv.querySelector('.quiz-explanation');
        if (expDiv) {
          expDiv.hidden = false;
          expDiv.innerHTML = `<strong>${isCorrect ? '✓ Correct!' : '✗ Incorrect.'}</strong> ${escapeHtml(q.explanation || '')}`;
          expDiv.className = `quiz-explanation quiz-explanation--${isCorrect ? 'correct' : 'wrong'}`;
        }
      });
      const pct = Math.round((correct / questions.length) * 100);
      document.getElementById('quiz-score').innerHTML = `
        <div class="quiz-result">
          <span class="quiz-result__score ${pct >= 80 ? 'quiz-result__score--pass' : pct >= 60 ? 'quiz-result__score--ok' : 'quiz-result__score--fail'}">
            ${correct}/${questions.length} · ${pct}%
          </span>
          <span class="quiz-result__label">${pct >= 80 ? '🏆 Excellent!' : pct >= 60 ? '👍 Good effort!' : '📖 Keep studying!'}</span>
        </div>
      `;
      await StorageManager.addQuizAttempt(course.id, lesson.id, correct, questions.length);
      await StorageManager.updateStreak();
      await UIRenderer.updateStreakDisplay();
      
      // Dispatch event to refresh lesson modal library AND the dashboard
      const lessonModal = document.getElementById('lesson-modal');
      if (lessonModal) {
        lessonModal.dispatchEvent(new CustomEvent('quiz-saved'));
      }
      // NEW: Dispatch global event for dashboard refresh
      document.dispatchEvent(new CustomEvent('quiz-attempt-saved', {
        detail: { courseId: course.id }
      }));

      submitBtn.disabled = true;
    });
  }

  // Doubt detail modal with chunked TTS for answer
  function showDoubtDetailModal(question, answer) {
    document.getElementById('doubt-detail-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'doubt-detail-modal';
    modal.className = 'doubt-detail-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="doubt-detail-modal__backdrop"></div>
      <div class="doubt-detail-modal__box card">
        <div class="doubt-detail-modal__header">
          <h3 class="doubt-detail-modal__title">Doubt Details</h3>
          <button class="icon-btn" id="doubt-detail-close-btn" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1l12 12M13 1L1 13"/></svg>
          </button>
        </div>
        <div class="doubt-detail-modal__body">
          <div class="doubt-detail-question">
            <strong>Question:</strong>
            <p>${escapeHtml(question)}</p>
          </div>
          <div class="doubt-detail-answer">
            <strong>Answer: </strong>
            <pre style="white-space: pre-wrap; word-wrap: break-word; background: rgba(0,0,0,0.1); padding: 10px; border-radius: 5px;">${escapeHtml(answer)}</pre>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));

    // Add listen button for answer
    const answerDiv = modal.querySelector('.doubt-detail-answer');
    const listenAnswerBtn = document.createElement('button');
    listenAnswerBtn.className = 'icon-btn';
    listenAnswerBtn.innerHTML = '🔊';
    listenAnswerBtn.title = 'Listen to answer';
    listenAnswerBtn.style.marginLeft = '10px';
    answerDiv.querySelector('strong').appendChild(listenAnswerBtn);

    let cancelTTS = null;
    let isPlaying = false;

    listenAnswerBtn.addEventListener('click', () => {
      console.log('[UI] Answer button clicked, isPlaying:', isPlaying);
      
      if (isPlaying) {
        console.log('[UI] Stopping answer playback');
        if (typeof cancelTTS === 'function') {
          cancelTTS();
          cancelTTS = null;
        }
        isPlaying = false;
        listenAnswerBtn.innerHTML = '🔊';
        listenAnswerBtn.title = 'Listen to answer';
        return;
      }

      const fullText = answer;
      console.log('[UI] Starting answer playback, text length:', fullText.length);

      listenAnswerBtn.innerHTML = '⏳';
      listenAnswerBtn.disabled = true;

      const cancelPromise = playTextWithTTS(
        fullText,
        () => {
          console.log('[UI] Answer TTS started');
          isPlaying = true;
          listenAnswerBtn.innerHTML = '⏸️';
          listenAnswerBtn.title = 'Stop';
          listenAnswerBtn.disabled = false;
        },
        () => {
          console.log('[UI] Answer TTS stopped');
          isPlaying = false;
          listenAnswerBtn.innerHTML = '🔊';
          listenAnswerBtn.title = 'Listen to answer';
          listenAnswerBtn.disabled = false;
          cancelTTS = null;
        },
        (errorMsg) => {
          UIRenderer.toast(errorMsg, 'error');
          isPlaying = false;
          listenAnswerBtn.innerHTML = '🔊';
          listenAnswerBtn.title = 'Listen to answer';
          listenAnswerBtn.disabled = false;
          cancelTTS = null;
        }
      );

      cancelPromise.then(cancel => {
        cancelTTS = cancel;
      }).catch(err => {
        console.error('[UI] Failed to get cancel function:', err);
        UIRenderer.toast('Could not initialize TTS', 'error');
        listenAnswerBtn.innerHTML = '🔊';
        listenAnswerBtn.disabled = false;
      });
    });

    const closeModal = () => {
      if (cancelTTS) cancelTTS();
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 300);
    };

    modal.querySelector('.doubt-detail-modal__backdrop').addEventListener('click', closeModal);
    modal.querySelector('#doubt-detail-close-btn').addEventListener('click', closeModal);
    const onEsc = e => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
  }

  // Confirm modal
  function showConfirmModal(message, onConfirm) {
    document.getElementById('confirm-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'confirm-modal';
    modal.className = 'confirm-modal lesson-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="confirm-modal__backdrop lesson-modal__backdrop"></div>
      <div class="confirm-modal__box card lesson-modal__box">
        <div class="confirm-modal__header lesson-modal__header">
          <h3 class="confirm-modal__title">Confirm</h3>
          <button class="icon-btn" id="confirm-close-btn" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1l12 12M13 1L1 13"/></svg></button>
        </div>
        <div class="confirm-modal__message">${escapeHtml(message)}</div>
        <div class="confirm-modal__actions">
          <button class="btn btn--outline" id="confirm-cancel-btn">Cancel</button>
          <button class="btn btn--primary" id="confirm-ok-btn">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));
    const close = () => {
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 300);
    };
    modal.querySelector('.confirm-modal__backdrop').addEventListener('click', close);
    modal.querySelector('#confirm-close-btn').addEventListener('click', close);
    modal.querySelector('#confirm-cancel-btn').addEventListener('click', close);
    modal.querySelector('#confirm-ok-btn').addEventListener('click', () => {
      close();
      onConfirm();
    });
    const onEsc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
  }

  // ========== SHARE MODAL ==========
  function showShareModal(link) {
    document.getElementById('share-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'share-modal';
    modal.innerHTML = `
      <div class="share-modal__backdrop"></div>
      <div class="share-modal__box card">
        <h3 class="share-modal__title">Share Course</h3>
        <p>Anyone with this link can view and import the course.</p>
        <input type="text" id="share-link-input" class="share-modal__input" value="${link}" readonly>
        <div class="share-modal__actions">
          <button class="btn btn--primary" id="copy-link-btn">Copy Link</button>
          <button class="btn btn--outline" id="close-share-btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));

    const close = () => {
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 300);
    };
    modal.querySelector('.share-modal__backdrop').addEventListener('click', close);
    modal.querySelector('#close-share-btn').addEventListener('click', close);

    const copyBtn = modal.querySelector('#copy-link-btn');
    const input = modal.querySelector('#share-link-input');
    
    copyBtn.addEventListener('click', () => {
      input.select();
      input.setSelectionRange(0, 99999);

      try {
        navigator.clipboard.writeText(link).then(() => {
          UIRenderer.toast('Link copied!', 'success');
        }).catch(() => {
          document.execCommand('copy');
          UIRenderer.toast('Link copied!', 'success');
        });
      } catch (err) {
        UIRenderer.toast('Press Ctrl+C to copy', 'info');
      }
    });
  }

  // ========== IMPORT URL MODAL ==========
  function showImportUrlModal() {
    document.getElementById('import-url-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'import-url-modal';
    modal.className = 'share-modal';
    modal.innerHTML = `
      <div class="share-modal__backdrop"></div>
      <div class="share-modal__box card">
        <h3 class="share-modal__title">Import from Share Link</h3>
        <p>Paste the share link below to import a course.</p>
        <input type="url" id="import-url-input" class="share-modal__input" placeholder="https://edumapai.com/share.html?id=..." autofocus>
        <div class="share-modal__actions">
          <button class="btn btn--primary" id="import-url-submit">Import</button>
          <button class="btn btn--outline" id="import-url-close">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));

    const close = () => {
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 300);
    };
    modal.querySelector('.share-modal__backdrop').addEventListener('click', close);
    modal.querySelector('#import-url-close').addEventListener('click', close);

    const submitBtn = modal.querySelector('#import-url-submit');
    const input = modal.querySelector('#import-url-input');
    submitBtn.addEventListener('click', () => {
      const url = input.value.trim();
      if (!url) {
        toast('Please enter a URL.', 'error');
        return;
      }
      try {
        const urlObj = new URL(url);
        const shareId = urlObj.searchParams.get('id');
        if (!shareId) throw new Error('No share ID found');
        close();
        App.importFromLink(shareId);
      } catch (e) {
        toast('Invalid share link.', 'error');
      }
    });
  }

  // ========== LOGIN MODAL FUNCTIONS ==========
  function showLoginModal() {
    const modal = document.getElementById('login-modal');
    if (!modal) return;
    modal.classList.add('is-open');
    modal.style.display = 'flex';
  }
  function hideLoginModal() {
    const modal = document.getElementById('login-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
  }
  function updateUserMenu(user) {
    const userMenu = document.getElementById('user-menu');
    const userName = document.getElementById('user-name');
    const userEmail = document.getElementById('user-email');
    const userAvatar = document.getElementById('user-avatar');
    const streakDisplay = document.getElementById('streak-display');
    if (user) {
      userMenu.style.display = 'inline-block';
      userName.textContent = user.displayName || 'User';
      userEmail.textContent = user.email || '';
      if (user.photoURL) {
        userAvatar.innerHTML = `<img src="${user.photoURL}" style="width:100%; height:100%; border-radius:50%;">`;
      } else {
        userAvatar.textContent = user.displayName ? user.displayName[0].toUpperCase() : '👤';
      }
      streakDisplay.title = 'Synced to cloud';
    } else {
      userMenu.style.display = 'none';
      userAvatar.textContent = '👤';
      streakDisplay.title = 'Local streak';
    }
  }
  function initLoginModal() {
    console.log('initLoginModal called');
    const modal = document.getElementById('login-modal');
    if (!modal) {
      console.error('Login modal not found');
      return;
    }
    const backdrop = modal.querySelector('.login-modal__backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', hideLoginModal);
    }
    const googleBtn = document.getElementById('google-signin-btn');
    if (googleBtn) {
      googleBtn.addEventListener('click', async () => {
        try {
          await AuthManager.signInWithGoogle();
          hideLoginModal();
          document.body.classList.remove('login-mode');
          document.querySelector('.navbar').style.display = 'block';
          // The auth listener will handle any pending import
          App.navigate('generator');
          toast('Signed in successfully!', 'success');
        } catch (e) {
          toast('Sign-in failed. Try again.', 'error');
        }
      });
    }
    const guestLink = document.getElementById('continue-as-guest');
    if (guestLink) {
      guestLink.addEventListener('click', (e) => {
        e.preventDefault();
        hideLoginModal();
        document.body.classList.remove('login-mode');
        document.querySelector('.navbar').style.display = 'block';
        // If there is a pending import, run it now
        if (App.pendingImportId) {
          App.importSharedCourse(App.pendingImportId);
          App.pendingImportId = null;
        } else {
          App.navigate('generator');
        }
        toast('Continuing as guest. Data saved locally.', 'default');
      });
    }
  }
  function initUserMenu() {
    const trigger = document.getElementById('user-menu-trigger');
    const dropdown = document.getElementById('user-menu-dropdown');
    const logoutBtn = document.getElementById('logout-btn');
    if (!trigger) return;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dropdown.style.display === 'block';
      dropdown.style.display = isVisible ? 'none' : 'block';
    });
    document.addEventListener('click', () => {
      dropdown.style.display = 'none';
    });
    logoutBtn.addEventListener('click', async () => {
      await AuthManager.signOutUser();
      toast('Signed out.', 'default');
      document.querySelector('.navbar').style.display = 'none';
      document.body.classList.add('login-mode');
      showLoginModal();
    });
  }

  function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe).replace(/[&<>"]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[m]);
  }

  return {
    toast, showFieldError, clearFieldErrors, selectSegment,
    setGenerateLoading, setSaveLoading,
    updateNavCount, updateStreakDisplay,
    renderResultCard, hideResultCard,
    renderLibrary, renderLibraryLoading, filterLibrary,
    renderDashboard,
    showLessonModal, closeLessonModal, showQuizModal, showDoubtDetailModal, showConfirmModal,
    showShareModal, showImportUrlModal,
    escapeHtml,
    showLoginModal, hideLoginModal, updateUserMenu, initLoginModal, initUserMenu,
  };
})();

// ============================================================
// APP CONTROLLER (includes share, import, report)
// ============================================================
const App = (() => {
  let activeCourseId = null;
  let pendingCourse = null;
  let pendingImportId = null; // store import ID for after login/guest

  function navigate(page) {
    ['generator', 'library', 'dashboard'].forEach(p => {
      const el = document.getElementById(`page-${p}`);
      if (el) el.hidden = (p !== page);
    });
    document.querySelectorAll('.navbar__link').forEach(btn => {
      const active = btn.dataset.page === page;
      btn.classList.toggle('navbar__link--active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (page === 'library') loadLibrary();
    if (page === 'dashboard' && activeCourseId) loadDashboard();
  }

  async function generateCourse() {
    UIRenderer.clearFieldErrors();
    const subject = document.getElementById('subject')?.value.trim() || '';
    const duration = document.getElementById('duration')?.value || '';
    const unit = document.getElementById('unit')?.value || 'weeks';
    const difficulty = document.getElementById('difficulty')?.value || 'beginner';

    const errors = CourseEngine.validate(subject, duration);
    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([f, m]) => UIRenderer.showFieldError(f, m));
      return;
    }

    UIRenderer.hideResultCard();
    UIRenderer.setGenerateLoading(true);

    try {
      let course;
      // Proxy is always available, so we can always try Gemini
      try {
        course = await GeminiAI.generateCourse({ subject, duration, unit, difficulty });
      } catch (e) {
        console.error('Gemini error, falling back:', e);
        UIRenderer.toast('Gemini failed, using fallback content.', 'error', 4000);
        course = FallbackGenerator.generateCourse({ subject, duration, unit, difficulty });
      }
      pendingCourse = course;
      UIRenderer.renderResultCard(course);
    } catch (err) {
      UIRenderer.toast('Generation failed: ' + err.message, 'error');
    } finally {
      UIRenderer.setGenerateLoading(false);
    }
  }

  async function saveCourse() {
    if (!pendingCourse) return;
    UIRenderer.setSaveLoading(true);
    try {
      await StorageManager.add(pendingCourse);
      pendingCourse = null;
      UIRenderer.hideResultCard();
      await UIRenderer.updateNavCount();
      UIRenderer.toast('Course saved to library!', 'success');
      document.getElementById('subject').value = '';
      document.getElementById('duration').value = '4';
      setTimeout(() => navigate('library'), 700);
    } catch (err) {
      UIRenderer.toast('Save failed: ' + err.message, 'error');
    } finally {
      UIRenderer.setSaveLoading(false);
    }
  }

  function clearResult() { pendingCourse = null; UIRenderer.hideResultCard(); }

  async function loadLibrary() {
    UIRenderer.renderLibraryLoading();
    const courses = await StorageManager.getAll();
    UIRenderer.renderLibrary(courses, document.getElementById('library-search')?.value || '');
    await UIRenderer.updateNavCount();
    await UIRenderer.updateStreakDisplay();
  }

  async function openDashboard(id) {
    activeCourseId = id;
    navigate('dashboard');
    await UIRenderer.updateStreakDisplay();
  }

  async function loadDashboard() {
    const course = await StorageManager.getById(activeCourseId);
    if (!course) { navigate('library'); return; }
    UIRenderer.renderDashboard(course);

    const handleQuizAttempt = (e) => {
      if (e.detail.courseId === activeCourseId) {
        loadDashboard();
      }
    };
    document.removeEventListener('quiz-attempt-saved', handleQuizAttempt);
    document.addEventListener('quiz-attempt-saved', handleQuizAttempt);
  }

  async function toggleLesson(courseId, lessonId, forceComplete) {}
  async function markAllLessons(complete) {}

  function openLesson(course, lesson) { UIRenderer.showLessonModal(course, lesson); }

  async function deleteCourse(id) {
    UIRenderer.showConfirmModal('Are you sure you want to delete this course? This action cannot be undone.', async () => {
      await StorageManager.remove(id);
      UIRenderer.toast('Course deleted.', 'default');
      await UIRenderer.updateNavCount();
      if (activeCourseId === id) navigate('library');
      else await loadLibrary();
    });
  }

  async function exportCourse(id) {
    const course = await StorageManager.getById(id);
    if (!course) return;
    const dataStr = JSON.stringify(course, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${course.subject.replace(/\s+/g, '_')}_roadmap.json`;
    a.click();
    URL.revokeObjectURL(url);
    UIRenderer.toast('Course exported!', 'success');
  }

  async function duplicateCourse(id) {
    const course = await StorageManager.getById(id);
    if (!course) return;
    const newCourse = {
      ...course,
      id: undefined,
      createdAt: new Date().toISOString(),
      lessons: course.lessons.map(l => ({ ...l, id: Date.now() + '-' + Math.random().toString(36).substr(2, 6) }))
    };
    await StorageManager.add(newCourse);
    UIRenderer.toast('Course duplicated!', 'success');
    await UIRenderer.updateNavCount();
    if (!document.getElementById('page-library').hidden) await loadLibrary();
  }

  async function importCourse(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const course = JSON.parse(e.target.result);
        if (!course.subject || !course.duration || !course.unit || !course.difficulty || !Array.isArray(course.lessons)) {
          throw new Error('Invalid course file: missing required fields.');
        }
        course.id = undefined;
        course.createdAt = new Date().toISOString();
        course.lessons = course.lessons.map(l => ({ ...l, notes: l.notes || '', doubts: l.doubts || [], quizzes: l.quizzes || [] }));
        await StorageManager.add(course);
        UIRenderer.toast('Course imported successfully!', 'success');
        await UIRenderer.updateNavCount();
        await loadLibrary();
      } catch (err) {
        UIRenderer.toast('Import failed: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  // ========== SHARE FEATURE ==========
  async function shareCourse(courseId) {
    try {
      const link = await StorageManager.createShareLink(courseId);
      UIRenderer.showShareModal(link);
    } catch (error) {
      UIRenderer.toast('Failed to create share link.', 'error');
      console.error(error);
    }
  }

  async function importSharedCourse(shareId) {
    console.log('[Import] importSharedCourse called with shareId:', shareId);
    try {
      const sharedCourse = await StorageManager.getSharedCourse(shareId);
      console.log('[Import] Fetched shared course:', sharedCourse);
      if (!sharedCourse) {
        UIRenderer.toast('Shared course not found.', 'error');
        return;
      }

      const course = {
        subject: sharedCourse.subject,
        duration: sharedCourse.duration,
        unit: sharedCourse.unit,
        difficulty: sharedCourse.difficulty,
        totalDays: sharedCourse.totalDays,
        description: sharedCourse.description,
        createdAt: new Date().toISOString(),
        lessons: sharedCourse.lessons.map(l => ({
          ...l,
          notes: '',
          doubts: [],
          quizzes: []
        })),
        importedFrom: shareId,
        importedAt: new Date().toISOString()
      };

      console.log('[Import] Adding course to library:', course.subject);
      const newCourse = await StorageManager.add(course);
      console.log('[Import] Course added successfully:', newCourse);

      UIRenderer.toast('Course imported successfully!', 'success');
      navigate('library');
      await loadLibrary();
    } catch (error) {
      console.error('[Import] Error during import:', error);
      UIRenderer.toast('Failed to import course.', 'error');
    }
  }

  async function importFromLink(shareId) {
    if (!AuthManager.isLoggedIn()) {
      const onAuth = (user) => {
        AuthManager.removeListener(onAuth);
        importSharedCourse(shareId);
      };
      AuthManager.addListener(onAuth);
      UIRenderer.showLoginModal();
    } else {
      await importSharedCourse(shareId);
    }
  }

  // ========== CHECK FOR IMPORT PARAMETER ==========
  async function checkForImport() {
    const urlParams = new URLSearchParams(window.location.search);
    const importId = urlParams.get('import');
    console.log('[Import] Found import ID in URL:', importId);
    if (importId) {
      history.replaceState({}, document.title, window.location.pathname);
      pendingImportId = importId;
      console.log('[Import] Stored pendingImportId:', pendingImportId);

      if (!AuthManager.isLoggedIn()) {
        console.log('[Import] User not logged in, showing login modal');
        const onAuth = (user) => {
          console.log('[Import] Auth listener fired, user:', user?.email);
          AuthManager.removeListener(onAuth);
          if (pendingImportId) {
            console.log('[Import] Calling importSharedCourse with:', pendingImportId);
            importSharedCourse(pendingImportId);
            pendingImportId = null;
          }
        };
        AuthManager.addListener(onAuth);
        UIRenderer.showLoginModal();
      } else {
        console.log('[Import] User already logged in, importing immediately');
        await importSharedCourse(importId);
        pendingImportId = null;
      }
    }
  }

  // ========== FINAL EVALUATION REPORT ==========
  async function generateReport(courseId) {
    const course = await StorageManager.getById(courseId);
    if (!course) {
      UIRenderer.toast('Course not found.', 'error');
      return;
    }

    const user = AuthManager.getUser();
    const studentName = user?.displayName || user?.email || 'Guest User';

    const streak = await StorageManager.getStreak();
    const completedLessons = course.lessons.filter(l => l.completed).length;
    const totalLessons = course.lessons.length;

    let totalQuizScore = 0;
    let totalQuizQuestions = 0;
    course.lessons.forEach(lesson => {
      if (lesson.quizzes && lesson.quizzes.length > 0) {
        lesson.quizzes.forEach(quiz => {
          totalQuizScore += quiz.score;
          totalQuizQuestions += quiz.totalQuestions;
        });
      }
    });
    const avgPercent = totalQuizQuestions > 0 ? Math.round((totalQuizScore / totalQuizQuestions) * 100) : 0;
    const pointerOutOf10 = totalQuizQuestions > 0 ? ((totalQuizScore / totalQuizQuestions) * 10).toFixed(1) : '0.0';

    let remark = '';
    if (avgPercent >= 90) {
      remark = 'Outstanding! You have mastered this course.';
    } else if (avgPercent >= 75) {
      remark = 'Great job! You have a solid understanding.';
    } else if (avgPercent >= 60) {
      remark = 'Good effort. Review the lessons you found challenging.';
    } else if (avgPercent > 0) {
      remark = 'Keep practicing. Revisit the quizzes to strengthen your knowledge.';
    } else {
      remark = 'No quizzes taken. Take quizzes to evaluate your progress.';
    }

    const reportHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Final Evaluation – ${UIRenderer.escapeHtml(course.subject)}</title>
  <style>
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: #f9fafb;
      color: #111827;
      line-height: 1.6;
      padding: 2rem;
      max-width: 1000px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      margin-bottom: 2rem;
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 1.5rem;
    }
    .logo {
      width: 120px;
      height: 120px;
      object-fit: contain;
      margin-bottom: 1rem;
    }
    .course-title {
      font-size: 2.2rem;
      font-weight: 700;
      color: #1f2937;
      margin: 0;
    }
    .student-info {
      margin: 1rem 0 2rem 0;
      font-size: 1.1rem;
      color: #4b5563;
      border-left: 4px solid #8b5cf6;
      padding-left: 1rem;
    }
    .student-name {
      font-weight: 600;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: white;
      border-radius: 0.75rem;
      padding: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      text-align: center;
    }
    .stat-label {
      font-size: 0.75rem;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #111827;
    }
    .pointer-card {
      background: white;
      border-radius: 0.75rem;
      padding: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      text-align: center;
      margin-bottom: 2rem;
      border: 2px solid #8b5cf6;
    }
    .pointer-label {
      font-size: 0.75rem;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .pointer-value {
      font-size: 2rem;
      font-weight: 800;
      color: #8b5cf6;
    }
    .section-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 2rem 0 1rem;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 0.5rem;
    }
    .lesson-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .lesson-item {
      background: white;
      border-radius: 0.5rem;
      padding: 1rem;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }
    .lesson-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }
    .lesson-day {
      font-weight: 600;
      color: #4b5563;
      min-width: 60px;
    }
    .lesson-title {
      flex: 1;
      margin-left: 1rem;
      color: #111827;
      font-size: 0.95rem;
    }
    .quiz-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .quiz-badge {
      background: #f3f4f6;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #1f2937;
    }
    .remark {
      background: #ede9fe;
      border-left: 4px solid #8b5cf6;
      padding: 1rem 1.5rem;
      margin: 2rem 0;
      border-radius: 0.5rem;
      font-size: 1.1rem;
      color: #1f2937;
    }
    .remark strong {
      color: #6d28d9;
    }
    .footer {
      margin-top: 3rem;
      text-align: center;
      font-size: 0.875rem;
      color: #9ca3af;
    }
    @media print {
      body { background: white; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="https://i.postimg.cc/g0Wdp2VG/EDUMAP-BLACK-LOGO.png" alt="EdumapAI" class="logo">
    <div class="course-title">${UIRenderer.escapeHtml(course.subject)}</div>
  </div>

  <div class="student-info">
    <span class="student-name">Student Name: ${UIRenderer.escapeHtml(studentName)}</span>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">DURATION</div>
      <div class="stat-value">${course.duration} ${course.unit}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">LESSONS</div>
      <div class="stat-value">${completedLessons}/${totalLessons}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">STREAK</div>
      <div class="stat-value">${streak.count} day${streak.count !== 1 ? 's' : ''}</div>
    </div>
  </div>

  <div class="pointer-card">
    <div class="pointer-label">TOTAL POINTER</div>
    <div class="pointer-value">${pointerOutOf10} / 10</div>
  </div>

  <h2 class="section-title">LESSON DETAILS</h2>
  <div class="lesson-list">
    ${course.lessons.map(lesson => {
      const quizBadges = lesson.quizzes && lesson.quizzes.length > 0
        ? lesson.quizzes.map(q => 
            `<span class="quiz-badge" title="${new Date(q.date).toLocaleDateString()}">${q.score}/${q.totalQuestions}</span>`
          ).join('')
        : '<span class="quiz-badge">No quizzes</span>';
      return `
        <div class="lesson-item">
          <div class="lesson-header">
            <span class="lesson-day">Day ${lesson.day || '?'}</span>
            <span class="lesson-title">${UIRenderer.escapeHtml(lesson.title)}</span>
          </div>
          <div class="quiz-badges">
            ${quizBadges}
          </div>
        </div>
      `;
    }).join('')}
  </div>

  <div class="remark">
    <strong>REMARK</strong><br>
    ${remark}
  </div>

  <div class="footer no-print">
    Report generated on ${new Date().toLocaleString()}
  </div>
  <div style="text-align: center; margin-top: 2rem;" class="no-print">
    <button onclick="window.print()" style="background:#8b5cf6; color:white; border:none; padding:0.75rem 2rem; border-radius:9999px; cursor:pointer; font-weight:600;">Save as PDF / Print</button>
  </div>
</body>
</html>
    `;

    const reportWindow = window.open('', '_blank');
    reportWindow.document.write(reportHTML);
    reportWindow.document.close();
  }

  // ========== INIT ==========
  async function init() {
    ThemeManager.init();
    await AuthManager.init();
    AuthManager.addListener((user) => {
      UIRenderer.updateUserMenu(user);
      if (!document.getElementById('page-library').hidden) loadLibrary();
      if (!document.getElementById('page-dashboard').hidden && activeCourseId) loadDashboard();
    });
    UIRenderer.initLoginModal();
    UIRenderer.initUserMenu();
    document.querySelector('.navbar').style.display = 'none';
    UIRenderer.showLoginModal();
    document.body.classList.add('login-mode');

    window.UI = UIRenderer;
    window.App = App;

    // Check for import parameter in URL
    checkForImport();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    navigate, generateCourse, saveCourse, clearResult,
    openDashboard, toggleLesson, markAllLessons, openLesson,
    deleteCourse, exportCourse, duplicateCourse, importCourse,
    shareCourse, importFromLink, importSharedCourse, generateReport,
    pendingImportId,
  };
})();