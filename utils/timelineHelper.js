const SUBJECT_MAP = {
    '数学': '#0074FF', 'blue': '#0074FF', 'math': '#0074FF', '#0074FF': '#0074FF',
    '化学': '#66CCFF', 'lightblue': '#66CCFF', 'chemistry': '#66CCFF', '#66CCFF': '#66CCFF',
    '物理': '#FFA500', 'orange': '#FFA500', 'physics': '#FFA500', '#FFA500': '#FFA500',
    '英語': '#FFFF00', 'yellow': '#FFFF00', 'english': '#FFFF00', '#FFFF00': '#FFFF00',
    '社会': '#00B000', 'green': '#00B000', 'social': '#00B000', '#00B000': '#00B000',
    'その他': '#808080', 'gray': '#808080', 'other': '#808080', '#808080': '#808080'
};

const SUBJECT_NAME_MAP = {
    'math': '数学', 'chemistry': '化学', 'physics': '物理',
    'english': '英語', 'social': '社会', 'other': 'その他',
    '#0074FF': '数学', '#66CCFF': '化学', '#FFA500': '物理',
    '#FFFF00': '英語', '#00B000': '社会', '#808080': 'その他'
};

function resolveSubjectColor(subject) {
    if (!subject) return '#808080';
    return SUBJECT_MAP[subject.toLowerCase()] || '#808080';
}

function resolveSubjectName(subject) {
    if (!subject) return '未設定';
    return SUBJECT_NAME_MAP[subject.toLowerCase()] || subject;
}

function formatTime(ms) {
    const safeMs = Math.max(0, ms);
    const totalMinutes = Math.floor(safeMs / 1000 / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}時間${minutes}分`;
}

function getTodayRange() {
    const JST_OFFSET = 9 * 60 * 60 * 1000;
    const nowJstMs = Date.now() + JST_OFFSET;
    const d = new Date(nowJstMs);
    const h = d.getUTCHours();
    const start = new Date(nowJstMs);
    
    if (h < 2) {
        start.setUTCDate(start.getUTCDate() - 1);
    }
    start.setUTCHours(2, 0, 0, 0);

    const end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + 1);
    end.setUTCHours(1, 59, 59, 999);

    return {
        startMs: start.getTime() - JST_OFFSET,
        endMs: end.getTime() - JST_OFFSET
    };
}

module.exports = {
    resolveSubjectColor,
    resolveSubjectName,
    formatTime,
    getTodayRange
};