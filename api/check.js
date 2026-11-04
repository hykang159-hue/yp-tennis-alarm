const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// 중복 알림 방지용 (Upstash 설정 시 자동 활성화, 미설정 시에도 정상 작동)
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TARGET_URL = 'https://srent.y-sisul.or.kr/page/rent/s04.od.list.asp';

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

module.exports = async (req, res) => {
  // 보안 키 검증 (URL 뒤에 ?secret=설정한비밀번호 형태로 접속)
  const clientSecret = req.headers['x-cron-secret'] || req.query.secret;
  if (CRON_SECRET && clientSecret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const response = await axios.get(TARGET_URL, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://srent.y-sisul.or.kr/'
      },
      timeout: 8000
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
    const prevSlots = await getPreviousSlots();
    const newSlots = uniqueCurrentSlots.filter(slot => !prevSlots.includes(slot));

    await saveCurrentSlots(uniqueCurrentSlots);

    if (newSlots.length > 0) {
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

      return res.status(200).json({ success: true, alerted: true, newSlots });
    }

    return res.status(200).json({
      success: true,
      alerted: false,
      totalAvailable: uniqueCurrentSlots.length,
      message: '새로 추가된 빈자리가 없습니다.'
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
