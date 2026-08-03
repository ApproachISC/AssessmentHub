import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderExamPaper } from '../exam-paper.js';

function showError(title, message) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorScreen').style.display = 'flex';
}

function waitForImages(root) {
  const imgs = Array.from(root.querySelectorAll('img'));
  return Promise.all(imgs.map(img => new Promise(resolve => {
    if (img.complete) return resolve();
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  })));
}

(async () => {
  const auth = await requireAuth();
  if (!auth) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) {
    showError('Missing exam ID', 'No exam ID was provided in the URL.');
    return;
  }

  document.getElementById('backLink').href = `edit.html?id=${encodeURIComponent(id)}`;

  try {
    const [examRes, classesRes, levelsRes, teachersRes] = await Promise.all([
      db.from('exams').select('*').eq('id', id).single(),
      db.from('classes').select('*'),
      db.from('levels').select('*'),
      db.from('profiles').select('id, full_name, email')
    ]);

    if (examRes.error) throw examRes.error;
    const exam = examRes.data;

    if (exam.status !== 'active') {
      showError('Exam not published', 'This exam must be published (Active) before a paper version can be printed.');
      return;
    }

    const examDef = exam.exam_definition;
    if (!examDef || !Array.isArray(examDef.sections) || examDef.sections.length === 0) {
      showError('No content', 'This exam has no questions to print.');
      return;
    }

    const cls = (classesRes.data || []).find(c => c.id === exam.class_id);
    const lvl = (levelsRes.data || []).find(l => l.id === exam.level_id);
    const tch = (teachersRes.data || []).find(t => t.id === exam.teacher_id);

    const paperHtml = renderExamPaper(examDef, {
      title: examDef.exam_metadata?.title || exam.code,
      code: exam.code,
      className: cls?.name || '—',
      levelName: lvl?.name || '—',
      teacherName: tch?.full_name || tch?.email || '—',
      instructions: examDef.exam_metadata?.instructions
    });

    const root = document.getElementById('paperRoot');
    root.innerHTML = paperHtml;

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    document.getElementById('printNowBtn').addEventListener('click', () => window.print());

    await waitForImages(root);
    window.print();
  } catch (err) {
    console.error(err);
    showError('Could not load exam', err.message || 'Unknown error');
  }
})();
