const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TARGET_URL = 'https://srent.y-sisul.or.kr/page/rent/s04.od.list.asp';
const CACHE_FILE = path.join(__dirname, 'last_slots.json');

const ALL_TIMES = [
  '06:00~08:00', '08:00~10:00', '10:00~12:00', '12:00~14:00',
  '14:00~16:00', '16:00~18:00', '18:00~20:00', '20:00~22:00'
];
const WEEKDAY_TIMES = ['18:00~20:00', '20:00~22:00'];

function getDayInfo(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dayOfWeek = dateObj.getDay();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return {
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    dayName: dayNames[dayOfWeek]
  };
}

function loadPreviousSlots() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('캐시 읽기 에러:', err.message);
  }
  return [];
}

function saveCurrentSlots(slots) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(slots, null, 2), 'utf-8');
  } catch (err) {
    console.error('캐시 저장 에러:', err.message);
  }
}

async function run() {
  try {
    console.log(`[${new Date().toLocaleString()}] 테니스장 크롤링 시작...`);

    const response = await axios.get(TARGET_URL, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': TARGET_URL,
      },
      timeout: 10000
    });

    const contentType = response.headers['content-type'] || '';
    const encoding = contentType.toLowerCase().includes('utf-8') ? 'utf-8' : 'euc-kr';
    const html = iconv.decode(response.data, encoding);
    const $ = cheerio.load(html);

    const currentSlots = [];

    $('a[href*="fn_rent_odchk1"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const match = href.match(/fn_rent_odchk1\(\s*'([^']+)'\s*,\s*'(\d{4}-\d{2}-\d{2})'\s*\)/);
      if (!match) return;

      const [, , dateStr] = match;
      const { isWeekend, dayName } = getDayInfo(dateStr);
      const targetTimes = isWeekend ? ALL_TIMES : WEEKDAY_TIMES;

      let rowText = $el.parent().text().replace(/\s+/g, ' ').trim();
      if (rowText.length > 40) {
        const prevText = $el[0].prev ? $($el[0].prev).text() : '';
        rowText = (prevText + ' ' + $el.text()).replace(/\s+/g, ' ').trim();
      }

      for (const time of targetTimes) {
        if (rowText.includes(time)) {
          const countMatch = $el.parent().text().match(/\(\d+\)/);
          const countStr = countMatch ? ` ${countMatch[0]}` : '';
          currentSlots.push(`📅 ${dateStr}(${dayName}) | ⏰ ${time}${countStr}`);
          break;
        }
      }
    });

    const uniqueCurrentSlots = [...new Set(currentSlots)].sort();
    const prevSlots = loadPreviousSlots();
    const newSlots = uniqueCurrentSlots.filter(slot => !prevSlots.includes(slot));

    saveCurrentSlots(uniqueCurrentSlots);

    if (newSlots.length > 0) {
      console.log(`🎉 신규 빈자리 발견! 알림을 발송합니다.`);
      const message = [
        `🎾 *[양평누리 테니스장 빈자리 알림!]*`,
        `조건: 주말 전체 / 평일 18~22시\n`,
        ...newSlots,
        `\n👉 [예약 페이지 바로가기](${TARGET_URL})`
      ].join('\n');

      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown'
        });
      }
    } else {
      console.log(uniqueCurrentSlots.length > 0 ? '기존 빈자리 유지 중 (알림 생략)' : '빈자리 없음');
    }

  } catch (error) {
    console.error('오류 발생:', error.message);
    process.exit(1);
  }
}

run();
