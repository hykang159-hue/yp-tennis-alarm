const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const BASE_URL = 'https://srent.y-sisul.or.kr/page/rent/s04.od.list.asp';
const TOTAL_COURTS = 6; // 총 코트 수 6면

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

// 한국 시간(KST) 기준 현재 연, 월, 일 구하기
function getKSTDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    day: kst.getUTCDate()
  };
}

async function getPreviousSlots() {
  if (!REDIS_URL || !REDIS_TOKEN) return [];
  try {
    const res = await axios.get(`${REDIS_URL}/get/ydp_tennis_slots`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    return res.data.result ? JSON.parse(res.data.result) : [];
  } catch (e) {
    return [];
  }
}

async function saveCurrentSlots(slots) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await axios.post(`${REDIS_URL}/set/ydp_tennis_slots`, JSON.stringify(slots), {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      params: { ex: 172800 }
    });
  } catch (e) {}
}

// 특정 URL(이번 달 또는 다음 달)에서 HTML을 가져와 빈자리 파싱
async function fetchAndParseMonth(targetUrl, isTestMode) {
  const response = await axios.get(targetUrl, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': BASE_URL
    },
    timeout: 8000
  });

  const contentType = response.headers['content-type'] || '';
  const encoding = contentType.toLowerCase().includes('utf-8') ? 'utf-8' : 'euc-kr';
  const html = iconv.decode(response.data, encoding);
  const $ = cheerio.load(html);

  const slots = [];

  $('a[href*="fn_rent_odchk1"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const match = href.match(/fn_rent_odchk1\(\s*'([^']+)'\s*,\s*'(\d{4}-\d{2}-\d{2})'\s*\)/);
    if (!match) return;

    const [, slotId, dateStr] = match;
    const { isWeekend, dayName } = getDayInfo(dateStr);
    const targetTimes = (isTestMode || isWeekend) ? ALL_TIMES : WEEKDAY_TIMES;

    const containerHtml = $el.closest('td, ul, div').html() || $el.parent().html() || '';
    const lines = containerHtml.split(/<br\s*\/?>|<\/li>|<\/div>|<\/p>|\n/i);
    
    let matchedLineText = '';
    for (const line of lines) {
      if (line.includes(slotId) && line.includes('fn_rent_odchk1')) {
        matchedLineText = cheerio.load(line).text().replace(/\s+/g, ' ').trim();
        break;
      }
    }

    if (!matchedLineText) {
      const prevNode = $el[0].prev;
      const nextNode = $el[0].next;
      const prevText = prevNode ? (prevNode.nodeValue || $(prevNode).text() || '') : '';
      const nextText = nextNode ? (nextNode.nodeValue || $(nextNode).text() || '') : '';
      matchedLineText = `${prevText} ${$el.text()} ${nextText}`.replace(/\s+/g, ' ').trim();
    }

    for (const time of targetTimes) {
      if (matchedLineText.includes(time)) {
        const countMatch = matchedLineText.match(/\((\d+)\)/);
        const bookedCount = countMatch ? parseInt(countMatch[1], 10) : 0;
        const availableCourts = TOTAL_COURTS - bookedCount;

        if (availableCourts > 0) {
          slots.push(`📅 ${dateStr}(${dayName}) | ⏰ ${time} (잔여 ${availableCourts}면 / 예약 ${bookedCount}/${TOTAL_COURTS})`);
        }
        break;
      }
    }
  });

  return slots;
}

module.exports = async (req, res) => {
  const clientSecret = req.headers['x-cron-secret'] || req.query.secret;
  if (CRON_SECRET && clientSecret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isTestMode = req.query.test === 'true';

  try {
    const { year, month, day } = getKSTDate();
    const currentMonthPad = String(month).padStart(2, '0');
    
    // 기본 스캔: 이번 달 (?sch_sym=YYYY-MM)
    const urlsToScan = [`${BASE_URL}?sch_sym=${year}-${currentMonthPad}`];

    // 매월 20일 이후(10일 전 오픈 대비)이거나 강제 테스트 파라미터(&nextMonth=true)가 있으면 다음 달도 추가 스캔!
    if (day >= 20 || req.query.nextMonth === 'true') {
      const nextYear = month === 12 ? year + 1 : year;
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextMonthPad = String(nextMonth).padStart(2, '0');
      
      urlsToScan.push(`${BASE_URL}?sch_sym=${nextYear}-${nextMonthPad}`);
    }

    let allSlots = [];
    for (const url of urlsToScan) {
      const slots = await fetchAndParseMonth(url, isTestMode);
      allSlots.push(...slots);
    }

    const uniqueCurrentSlots = [...new Set(allSlots)].sort();

    // 1. 테스트 모드일 때 (&test=true)
    if (isTestMode) {
      if (uniqueCurrentSlots.length > 0 && TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const sampleSlots = uniqueCurrentSlots.slice(0, 12);
        const moreText = uniqueCurrentSlots.length > 12 ? `\n...외 ${uniqueCurrentSlots.length - 12}건 더 있음` : '';

        const testMessage = [
          `🧪 *[양평누리 크롤링 테스트 성공!]*`,
          `스캔 대상: ${urlsToScan.map(u => u.split('sch_sym=')[1]).join(', ')}월`,
          `전체 빈자리(총 ${uniqueCurrentSlots.length}개 시간대):\n`,
          ...sampleSlots,
          moreText,
          `\n👉 [예약 페이지 바로가기](${BASE_URL})`
        ].join('\n');

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: testMessage,
          parse_mode: 'Markdown'
        });
      }

      return res.status(200).json({
        success: true,
        mode: 'TEST_MODE',
        scannedUrls: urlsToScan,
        foundCount: uniqueCurrentSlots.length,
        slots: uniqueCurrentSlots
      });
    }

    // 2. 실전 모니터링 모드
    const prevSlots = await getPreviousSlots();
    
    // 날짜+시간 기준으로 신규 오픈/취소표 여부 비교
    const getSlotKey = (s) => s.split(' (잔여')[0];
    const prevKeys = prevSlots.map(getSlotKey);
    const newSlots = uniqueCurrentSlots.filter(slot => !prevKeys.includes(getSlotKey(slot)));

    await saveCurrentSlots(uniqueCurrentSlots);

    if (newSlots.length > 0) {
      const message = [
        `🎾 *[양평누리 테니스장 빈자리 발생!]*`,
        `조건: 주말 전체 / 평일 18~22시\n`,
        ...newSlots,
        `\n👉 [예약 페이지 바로가기](${BASE_URL})`
      ].join('\n');

      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown'
        });
      }

      return res.status(200).json({ success: true, alerted: true, scannedUrls: urlsToScan, newSlots });
    }

    return res.status(200).json({
      success: true,
      alerted: false,
      scannedUrls: urlsToScan,
      currentMatchedCount: uniqueCurrentSlots.length,
      message: '새로 추가된 빈자리가 없습니다.'
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
