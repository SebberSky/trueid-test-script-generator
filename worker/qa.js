const qaClean = value => String(value || '').replace(/\\\\\*/g, '*').replace(/\\n/g, '\n').trim();

function rowsFromGwt(text) {
  return qaClean(text).split(/\r?\n/).filter(line => /^\s*\|/.test(line) && !/^\s*\|\s*-{2,}/.test(line))
    .map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim().replace(/\\\|/g, '|')))
    .filter(cells => cells.length >= 3 && !/^given$/i.test(cells[0]) && !/^when$/i.test(cells[1]));
}

function inferCases(rows, text) {
  const source = qaClean(text).toLowerCase();
  const cases = rows.map((row, index) => ({
    id: `QA-${String(index + 1).padStart(2, '0')}`,
    title: `ตรวจสอบเงื่อนไขกรณีที่ ${index + 1}`,
    given: row[0], when: row[1], then: row[2], source: 'GWT ใน Business Expectation',
  }));
  const extras = [
    ['การตอบสนองเมื่อข้อมูลหรือบริการภายนอกล้มเหลว', 'ระบบอยู่ในเงื่อนไขที่สามารถทำงานได้ แต่บริการที่ต้องเรียกใช้ตอบกลับผิดพลาด หมดเวลา หรือไม่พบข้อมูล', 'จำลอง HTTP 204, 4xx, 5xx, timeout และ response ว่าง', 'ระบบต้องจัดการอย่างปลอดภัย ไม่ค้าง ไม่แสดงสถานะผิด และทำ fallback ตาม business rule'],
    ['การเปลี่ยนสถานะระหว่างการทำงาน', 'ฟีเจอร์กำลังทำงานอยู่และมี state ปัจจุบันที่ตรวจสอบได้', 'ทำ action ซ้ำ, ย้อนกลับ, เปลี่ยนรายการ หรือออกจากหน้าจอระหว่างการทำงาน', 'ต้องคืน resource และไม่เกิด state ค้าง ข้อมูลซ้ำ เสียงค้าง หรือการทำงานของรายการเดิม'],
    ['ข้อมูลไม่ครบหรืออยู่นอกขอบเขต', 'API หรือ configuration ส่งค่า null, ว่าง, ไม่รู้จัก หรือไม่ตรงกับประเภทที่รองรับ', 'เปิดฟีเจอร์ด้วยข้อมูลดังกล่าว', 'ระบบต้องไม่ crash และต้องแสดง/ซ่อน/ใช้ค่า fallback ตามข้อกำหนด'],
  ];
  if (/timeout|no fill|error|fail|empty|ว่าง|ผิดพลาด/i.test(source)) extras.splice(0, 1);
  extras.forEach((item, offset) => cases.push({id: `QA-${String(cases.length + 1).padStart(2, '0')}`, title: item[0], given: item[1], when: item[2], then: item[3], source: 'QA edge case ที่อนุมานจาก Business Expectation'}));
  return cases;
}

export function businessToQaDetail(input = {}) {
  const ticketKey = String(input.ticketKey || 'ไม่ระบุเลขที่ทิคเกต').trim();
  const expectation = qaClean(input.businessExpectation || input.description || '');
  const comments = qaClean(input.comments || '');
  if (!expectation) throw new Error('ต้องระบุ Business Expectation หรือ Description ของทิคเกต');
  const rows = rowsFromGwt(expectation);
  const cases = inferCases(rows, expectation + '\n' + comments);
  return {
    title: `QA Execution Detail: ${ticketKey}`,
    language: 'ไทยเท่านั้น',
    source: {ticketKey, businessExpectation: expectation, qaContext: comments || 'ไม่มี QA context จาก comment'},
    testStrategy: 'ยึด Business Expectation เป็น expected behavior หลัก และใช้ comment เป็นบริบทสำหรับ test data, environment, evidence, known limitation และผลทดสอบเท่านั้น',
    preconditions: [
      'ติดตั้ง build และเลือก environment ตามที่ทิคเกตกำหนด',
      'เตรียมบัญชีผู้ใช้และข้อมูลที่ทำให้เข้าแต่ละ Given ได้จริง',
      'เปิด Network inspector หรือ Proxyman/Charles เพื่อเก็บ request และ response',
      'เปิด Console/OS log และเตรียมวิธีบันทึกหน้าจอหรือภาพหลักฐาน',
    ],
    testData: ['ข้อมูลผู้ใช้ตามระดับสิทธิ์ที่ business rule ระบุ', 'ข้อมูล content/config ทั้งค่าที่อนุญาตและไม่อนุญาต', 'ข้อมูลว่าง, null, ผิดรูปแบบ และ response ผิดพลาดสำหรับ edge case'],
    testCases: cases.map(testCase => ({
      ...testCase,
      precondition: `เตรียมระบบให้ตรงกับ Given: ${testCase.given}`,
      steps: [`เปิดแอปหรือหน้าฟีเจอร์ที่เกี่ยวข้องกับ ${ticketKey}`, `ตรวจสอบข้อมูลตั้งต้นให้ตรงกับ Given`, `ทำ action ตาม When: ${testCase.when}`, 'บันทึกผลลัพธ์บนหน้าจอ, network และ log', 'ทำซ้ำอย่างน้อยหนึ่งครั้งเพื่อยืนยันว่าไม่ใช่ผลจาก cache หรือ state เดิม'],
      expectedResult: testCase.then,
      evidence: ['ภาพหน้าจอหรือวิดีโอผลลัพธ์', 'Network request/response ที่เกี่ยวข้อง', 'Console หรือ player log', 'ข้อมูลผู้ใช้/config/content ที่ใช้ทดสอบ'],
      status: 'READY FOR QA',
    })),
    executionRules: ['ห้ามเปลี่ยน expected result ตาม implementation หากขัดกับ Business Expectation', 'หาก comment ขัดกับ GWT ให้บันทึกเป็น discrepancy หรือ defect แยกต่างหาก', 'ทุกกรณีต้องมีข้อมูลที่ใช้จริงและหลักฐานที่ตรวจสอบย้อนกลับได้', 'กรณีที่ทดสอบไม่ได้ให้ระบุสาเหตุและสถานะ BLOCKED/SKIP อย่างชัดเจน'],
    openQuestions: ['มีค่า configuration, user tier, content type หรือ test account ใดที่ต้องยืนยันก่อนรันหรือไม่', 'มี callback, API หรือ third-party service ใดที่ไม่สามารถ mock ได้หรือไม่', 'ต้องตรวจสอบ analytics, performance, accessibility หรือ device orientation เพิ่มหรือไม่'],
  };
}
