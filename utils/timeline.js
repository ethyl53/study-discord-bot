const { createCanvas } = require('canvas');

function buildTimelineSlots(intervals, startMs) {
    const CELL_COUNT = 288;
    const slots = new Array(CELL_COUNT).fill('#404249');

    for (const interval of intervals) {
        const sIdx = Math.max(0, Math.floor((interval.start_time - startMs) / (5 * 60 * 1000)));
        const eIdx = Math.min(CELL_COUNT - 1, Math.floor(((interval.end_time || Date.now()) - startMs) / (5 * 60 * 1000)));
        
        for (let i = sIdx; i <= eIdx; i++) {
            slots[i] = interval.color;
        }

        if (interval.pauses && interval.pauses.length > 0) {
            for (const p of interval.pauses) {
                const psIdx = Math.max(0, Math.floor((p.start - startMs) / (5 * 60 * 1000)));
                const peIdx = Math.min(CELL_COUNT - 1, Math.floor(((p.end || Date.now()) - startMs) / (5 * 60 * 1000)));
                for (let i = psIdx; i <= peIdx; i++) {
                    slots[i] = '#404249';
                }
            }
        }
    }
    return slots;
}

async function generateTimelineBuffer(userData, startMs) {
    const CELL_COUNT = 288;
    const CELL_WIDTH = 3;
    const CELL_HEIGHT = 16;
    const CELL_MARGIN = 1;
    const ROW_HEIGHT = 36;
    const LABEL_WIDTH = 100;
    const PADDING = 20;

    const width = LABEL_WIDTH + (CELL_WIDTH + CELL_MARGIN) * CELL_COUNT + PADDING * 2;
    const height = PADDING * 2 + 30 + userData.length * ROW_HEIGHT;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#2b2d31';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#949ba4';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    for (let h = 0; h <= 24; h += 2) {
        const cellIndex = h * 12;
        const x = LABEL_WIDTH + PADDING + cellIndex * (CELL_WIDTH + CELL_MARGIN);
        const displayHour = (2 + h) % 24;
        ctx.fillText(`${displayHour}:00`, x, PADDING + 10);
    }

    let startY = PADDING + 30;
    ctx.textBaseline = 'middle';
    
    userData.forEach(user => {
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.font = '13px sans-serif';
        ctx.fillText(user.username.slice(0, 10), LABEL_WIDTH + PADDING - 10, startY + ROW_HEIGHT / 2);

        const slots = buildTimelineSlots(user.intervals, startMs);

        for (let i = 0; i < CELL_COUNT; i++) {
            const x = LABEL_WIDTH + PADDING + i * (CELL_WIDTH + CELL_MARGIN);
            const y = startY + (ROW_HEIGHT - CELL_HEIGHT) / 2;
            
            ctx.fillStyle = slots[i];
            ctx.fillRect(x, y, CELL_WIDTH, CELL_HEIGHT);
        }
        startY += ROW_HEIGHT;
    });

    return canvas.toBuffer('image/png');
}

module.exports = { generateTimelineBuffer };