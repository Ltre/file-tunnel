(function () {
    'use strict';

    const STORAGE_KEY = 'drop2tunnel.language';
    const DEFAULT_LANG = 'zh-Hans';
    const SUPPORTED_LANGUAGES = [
        ['zh-Hans', '中文简体'],
        ['zh-Hant', '中文繁體'],
        ['en', 'English'],
        ['ja', '日本語'],
        ['fr', 'Français'],
        ['ru', 'Русский'],
        ['es', 'Español'],
        ['it', 'Italiano'],
        ['fa', 'فارسی'],
        ['ko', '한국어'],
        ['ms', 'Bahasa Melayu'],
        ['id', 'Bahasa Indonesia'],
        ['vi', 'Tiếng Việt'],
        ['km', 'ភាសាខ្មែរ'],
        ['my', 'မြန်မာဘာသာ'],
        ['th', 'ไทย']
    ];

    const CORE = {
        '隧道设置': { 'zh-Hant': '隧道設定', en: 'Tunnel settings', ja: 'トンネル設定', fr: 'Paramètres du tunnel', ru: 'Настройки туннеля', es: 'Ajustes del túnel', it: 'Impostazioni del tunnel', fa: 'تنظیمات تونل', ko: '터널 설정', ms: 'Tetapan terowong', id: 'Pengaturan tunnel', vi: 'Cài đặt đường hầm', km: 'ការកំណត់ផ្លូវរូង', my: 'တန်နယ် ဆက်တင်များ', th: 'การตั้งค่าอุโมงค์' },
        '工具与权限': { 'zh-Hant': '工具與權限', en: 'Tools and permissions', ja: 'ツールと権限', fr: 'Outils et autorisations', ru: 'Инструменты и разрешения', es: 'Herramientas y permisos', it: 'Strumenti e autorizzazioni', fa: 'ابزارها و مجوزها', ko: '도구 및 권한', ms: 'Alat dan keizinan', id: 'Alat dan izin', vi: 'Công cụ và quyền', km: 'ឧបករណ៍ និងសិទ្ធិ', my: 'ကိရိယာများနှင့် ခွင့်ပြုချက်များ', th: 'เครื่องมือและสิทธิ์' },
        '隧道工具': { 'zh-Hant': '隧道工具', en: 'Tunnel tools', ja: 'トンネルツール', fr: 'Outils du tunnel', ru: 'Инструменты туннеля', es: 'Herramientas del túnel', it: 'Strumenti del tunnel', fa: 'ابزارهای تونل', ko: '터널 도구', ms: 'Alat terowong', id: 'Alat tunnel', vi: 'Công cụ đường hầm', km: 'ឧបករណ៍ផ្លូវរូង', my: 'တန်နယ် ကိရိယာများ', th: 'เครื่องมืออุโมงค์' },
        '隧道权限': { 'zh-Hant': '隧道權限', en: 'Tunnel permissions', ja: 'トンネル権限', fr: 'Autorisations du tunnel', ru: 'Разрешения туннеля', es: 'Permisos del túnel', it: 'Permessi del tunnel', fa: 'مجوزهای تونل', ko: '터널 권한', ms: 'Keizinan terowong', id: 'Izin tunnel', vi: 'Quyền đường hầm', km: 'សិទ្ធិផ្លូវរូង', my: 'တန်နယ် ခွင့်ပြုချက်များ', th: 'สิทธิ์อุโมงค์' },
        '设置新加入设备的全局默认权限。隧道创建者始终保留管理权限。': { 'zh-Hant': '設定新加入裝置的全域預設權限。隧道建立者一律保留管理權限。', en: 'Set the global default permissions for newly joined devices. The tunnel creator always keeps management rights.', ja: '新しく参加するデバイスの既定権限を設定します。トンネル作成者は常に管理権限を保持します。', fr: 'Définissez les autorisations globales par défaut des nouveaux appareils. Le créateur du tunnel conserve toujours les droits de gestion.', ru: 'Задайте глобальные разрешения по умолчанию для новых устройств. Создатель туннеля всегда сохраняет права управления.', es: 'Define los permisos globales predeterminados para los dispositivos nuevos. El creador del túnel siempre conserva la administración.', it: 'Imposta i permessi globali predefiniti per i nuovi dispositivi. Il creatore del tunnel mantiene sempre i diritti di gestione.', fa: 'مجوزهای پیش‌فرض سراسری دستگاه‌های تازه‌وارد را تنظیم کنید. سازندهٔ تونل همیشه حق مدیریت را نگه می‌دارد.', ko: '새로 참여한 기기의 전역 기본 권한을 설정합니다. 터널 생성자는 항상 관리 권한을 유지합니다.', ms: 'Tetapkan keizinan lalai global untuk peranti baharu. Pencipta terowong sentiasa mengekalkan hak pengurusan.', id: 'Atur izin default global untuk perangkat baru. Pembuat tunnel selalu memiliki hak pengelolaan.', vi: 'Đặt quyền mặc định toàn cục cho thiết bị mới tham gia. Người tạo đường hầm luôn giữ quyền quản lý.', km: 'កំណត់សិទ្ធិលំនាំដើមសកលសម្រាប់ឧបករណ៍ដែលចូលរួមថ្មី។ អ្នកបង្កើតផ្លូវរូងនៅតែមានសិទ្ធិគ្រប់គ្រងជានិច្ច។', my: 'အသစ်ဝင်လာသော စက်များအတွက် ကမ္ဘာလုံးဆိုင်ရာ မူလခွင့်ပြုချက်များ သတ်မှတ်ပါ။ တန်နယ်ဖန်တီးသူသည် စီမံခန့်ခွဲခွင့်ကို အမြဲထိန်းထားသည်။', th: 'ตั้งค่าสิทธิ์เริ่มต้นส่วนกลางสำหรับอุปกรณ์ที่เข้าร่วมใหม่ ผู้สร้างอุโมงค์ยังคงมีสิทธิ์จัดการเสมอ' },
        '保存权限': { 'zh-Hant': '儲存權限', en: 'Save permissions', ja: '権限を保存', fr: 'Enregistrer les autorisations', ru: 'Сохранить разрешения', es: 'Guardar permisos', it: 'Salva permessi', fa: 'ذخیره مجوزها', ko: '권한 저장', ms: 'Simpan keizinan', id: 'Simpan izin', vi: 'Lưu quyền', km: 'រក្សាទុកសិទ្ធិ', my: 'ခွင့်ပြုချက်များ သိမ်းမည်', th: 'บันทึกสิทธิ์' },
        '指定设备管理员': { 'zh-Hant': '指定裝置管理員', en: 'Designated device admins', ja: '指定デバイス管理者', fr: 'Administrateurs d’appareil désignés', ru: 'Назначенные администраторы устройств', es: 'Administradores de dispositivo designados', it: 'Amministratori dispositivo designati', fa: 'مدیران دستگاه تعیین‌شده', ko: '지정 기기 관리자', ms: 'Pentadbir peranti tertentu', id: 'Admin perangkat khusus', vi: 'Quản trị viên thiết bị chỉ định', km: 'អ្នកគ្រប់គ្រងឧបករណ៍ដែលបានកំណត់', my: 'သတ်မှတ်ထားသော စက်အက်ဒမင်များ', th: 'ผู้ดูแลอุปกรณ์ที่กำหนด' },
        '在这里添加某台设备为管理员，并为它分配独立权限；未添加的设备继续使用上方默认权限。': { 'zh-Hant': '在這裡新增某台裝置為管理員，並分配獨立權限；未新增的裝置繼續使用上方預設權限。', en: 'Add a specific device as an admin here and assign independent permissions. Devices not added keep using the default permissions above.', ja: 'ここで特定のデバイスを管理者に追加し、個別権限を割り当てます。追加されていないデバイスは上の既定権限を使います。', fr: 'Ajoutez ici un appareil comme administrateur et attribuez-lui des autorisations indépendantes. Les autres appareils utilisent les autorisations par défaut ci-dessus.', ru: 'Добавьте здесь конкретное устройство как администратора и назначьте отдельные разрешения. Остальные устройства используют разрешения по умолчанию выше.', es: 'Añade aquí un dispositivo como administrador y asígnale permisos independientes. Los dispositivos no añadidos usan los permisos predeterminados de arriba.', it: 'Aggiungi qui un dispositivo come amministratore e assegnagli permessi indipendenti. Gli altri dispositivi usano i permessi predefiniti sopra.', fa: 'اینجا یک دستگاه مشخص را به‌عنوان مدیر اضافه کنید و مجوزهای مستقل بدهید. دستگاه‌های اضافه‌نشده از مجوزهای پیش‌فرض بالا استفاده می‌کنند.', ko: '여기서 특정 기기를 관리자로 추가하고 독립 권한을 부여합니다. 추가되지 않은 기기는 위의 기본 권한을 계속 사용합니다.', ms: 'Tambah peranti tertentu sebagai pentadbir dan berikan keizinan berasingan. Peranti lain terus menggunakan keizinan lalai di atas.', id: 'Tambahkan perangkat tertentu sebagai admin dan berikan izin terpisah. Perangkat lain tetap memakai izin default di atas.', vi: 'Thêm một thiết bị làm quản trị viên tại đây và gán quyền riêng. Thiết bị chưa thêm tiếp tục dùng quyền mặc định phía trên.', km: 'បន្ថែមឧបករណ៍ជាក់លាក់ជាអ្នកគ្រប់គ្រង ហើយផ្តល់សិទ្ធិដាច់ដោយឡែក។ ឧបករណ៍ផ្សេងទៀតបន្តប្រើសិទ្ធិលំនាំដើមខាងលើ។', my: 'ဤနေရာတွင် စက်တစ်လုံးကို အက်ဒမင်အဖြစ် ထည့်ပြီး သီးခြားခွင့်ပြုချက်များ ပေးပါ။ မထည့်ထားသောစက်များသည် အပေါ်က မူလခွင့်ပြုချက်များကို ဆက်သုံးမည်။', th: 'เพิ่มอุปกรณ์ที่ระบุเป็นผู้ดูแลและกำหนดสิทธิ์แยกต่างหาก อุปกรณ์ที่ไม่ได้เพิ่มจะใช้สิทธิ์เริ่มต้นด้านบนต่อไป' },
        '界面语言': { 'zh-Hant': '介面語言', en: 'Interface language', ja: '表示言語', fr: 'Langue de l’interface', ru: 'Язык интерфейса', es: 'Idioma de la interfaz', it: 'Lingua interfaccia', fa: 'زبان رابط کاربری', ko: '인터페이스 언어', ms: 'Bahasa antara muka', id: 'Bahasa antarmuka', vi: 'Ngôn ngữ giao diện', km: 'ភាសាចំណុចប្រទាក់', my: 'အင်တာဖေ့စ် ဘာသာစကား', th: 'ภาษาอินเทอร์เฟซ' },
        '选择在线设备': { 'zh-Hant': '選擇線上裝置', en: 'Choose an online device', ja: 'オンラインデバイスを選択', fr: 'Choisir un appareil en ligne', ru: 'Выберите онлайн-устройство', es: 'Elegir dispositivo en línea', it: 'Scegli un dispositivo online', fa: 'انتخاب دستگاه آنلاین', ko: '온라인 기기 선택', ms: 'Pilih peranti dalam talian', id: 'Pilih perangkat online', vi: 'Chọn thiết bị trực tuyến', km: 'ជ្រើសឧបករណ៍អនឡាញ', my: 'အွန်လိုင်းစက် ရွေးပါ', th: 'เลือกอุปกรณ์ออนไลน์' },
        '暂无可选在线设备': { 'zh-Hant': '暫無可選線上裝置', en: 'No online devices available', ja: '選択できるオンラインデバイスはありません', fr: 'Aucun appareil en ligne disponible', ru: 'Нет доступных онлайн-устройств', es: 'No hay dispositivos en línea disponibles', it: 'Nessun dispositivo online disponibile', fa: 'هیچ دستگاه آنلاینی در دسترس نیست', ko: '사용 가능한 온라인 기기가 없습니다', ms: 'Tiada peranti dalam talian', id: 'Tidak ada perangkat online', vi: 'Không có thiết bị trực tuyến', km: 'គ្មានឧបករណ៍អនឡាញដែលអាចជ្រើសបាន', my: 'ရွေးနိုင်သော အွန်လိုင်းစက် မရှိပါ', th: 'ไม่มีอุปกรณ์ออนไลน์ให้เลือก' },
        '或粘贴设备 ID': { 'zh-Hant': '或貼上裝置 ID', en: 'Or paste a device ID', ja: 'またはデバイス ID を貼り付け', fr: 'Ou collez un ID d’appareil', ru: 'Или вставьте ID устройства', es: 'O pega un ID de dispositivo', it: 'O incolla un ID dispositivo', fa: 'یا شناسه دستگاه را بچسبانید', ko: '또는 기기 ID 붙여넣기', ms: 'Atau tampal ID peranti', id: 'Atau tempel ID perangkat', vi: 'Hoặc dán ID thiết bị', km: 'ឬបិទភ្ជាប់ ID ឧបករណ៍', my: 'သို့မဟုတ် စက် ID ကူးထည့်ပါ', th: 'หรือวาง ID อุปกรณ์' },
        '添加管理员': { 'zh-Hant': '新增管理員', en: 'Add admin', ja: '管理者を追加', fr: 'Ajouter un administrateur', ru: 'Добавить администратора', es: 'Añadir administrador', it: 'Aggiungi amministratore', fa: 'افزودن مدیر', ko: '관리자 추가', ms: 'Tambah pentadbir', id: 'Tambah admin', vi: 'Thêm quản trị viên', km: 'បន្ថែមអ្នកគ្រប់គ្រង', my: 'အက်ဒမင် ထည့်မည်', th: 'เพิ่มผู้ดูแล' },
        '保存管理员权限': { 'zh-Hant': '儲存管理員權限', en: 'Save admin permissions', ja: '管理者権限を保存', fr: 'Enregistrer les autorisations admin', ru: 'Сохранить разрешения администратора', es: 'Guardar permisos de administrador', it: 'Salva permessi amministratore', fa: 'ذخیره مجوزهای مدیر', ko: '관리자 권한 저장', ms: 'Simpan keizinan pentadbir', id: 'Simpan izin admin', vi: 'Lưu quyền quản trị', km: 'រក្សាទុកសិទ្ធិអ្នកគ្រប់គ្រង', my: 'အက်ဒမင် ခွင့်ပြုချက်များ သိမ်းမည်', th: 'บันทึกสิทธิ์ผู้ดูแล' },
        '读取传输记录': { 'zh-Hant': '讀取傳輸記錄', en: 'Read transfer history', ja: '転送履歴の読み取り', fr: 'Lire l’historique des transferts', ru: 'Читать историю передач', es: 'Leer historial de transferencias', it: 'Leggi cronologia trasferimenti', fa: 'خواندن تاریخچه انتقال', ko: '전송 기록 읽기', ms: 'Baca sejarah pemindahan', id: 'Baca riwayat transfer', vi: 'Đọc lịch sử truyền', km: 'អានប្រវត្តិផ្ទេរ', my: 'လွှဲပြောင်းမှတ်တမ်း ဖတ်ရန်', th: 'อ่านประวัติการถ่ายโอน' },
        '发送文本': { 'zh-Hant': '傳送文字', en: 'Send text', ja: 'テキスト送信', fr: 'Envoyer du texte', ru: 'Отправлять текст', es: 'Enviar texto', it: 'Invia testo', fa: 'ارسال متن', ko: '텍스트 보내기', ms: 'Hantar teks', id: 'Kirim teks', vi: 'Gửi văn bản', km: 'ផ្ញើអត្ថបទ', my: 'စာသား ပို့ရန်', th: 'ส่งข้อความ' },
        '发送富文本': { 'zh-Hant': '傳送富文字', en: 'Send rich text', ja: 'リッチテキスト送信', fr: 'Envoyer du texte enrichi', ru: 'Отправлять форматированный текст', es: 'Enviar texto enriquecido', it: 'Invia testo avanzato', fa: 'ارسال متن غنی', ko: '리치 텍스트 보내기', ms: 'Hantar teks kaya', id: 'Kirim rich text', vi: 'Gửi văn bản định dạng', km: 'ផ្ញើអត្ថបទសម្បូរបែប', my: 'ရစ်ချ်စာသား ပို့ရန်', th: 'ส่งข้อความแบบจัดรูปแบบ' },
        '发送文件': { 'zh-Hant': '傳送檔案', en: 'Send files', ja: 'ファイル送信', fr: 'Envoyer des fichiers', ru: 'Отправлять файлы', es: 'Enviar archivos', it: 'Invia file', fa: 'ارسال فایل', ko: '파일 보내기', ms: 'Hantar fail', id: 'Kirim file', vi: 'Gửi tệp', km: 'ផ្ញើឯកសារ', my: 'ဖိုင် ပို့ရန်', th: 'ส่งไฟล์' },
        '删除记录': { 'zh-Hant': '刪除記錄', en: 'Delete records', ja: '記録を削除', fr: 'Supprimer les enregistrements', ru: 'Удалять записи', es: 'Eliminar registros', it: 'Elimina record', fa: 'حذف رکوردها', ko: '기록 삭제', ms: 'Padam rekod', id: 'Hapus catatan', vi: 'Xóa bản ghi', km: 'លុបកំណត់ត្រា', my: 'မှတ်တမ်းများ ဖျက်ရန်', th: 'ลบบันทึก' },
        '协同编辑': { 'zh-Hant': '協同編輯', en: 'Collaborative editing', ja: '共同編集', fr: 'Édition collaborative', ru: 'Совместное редактирование', es: 'Edición colaborativa', it: 'Modifica collaborativa', fa: 'ویرایش مشارکتی', ko: '공동 편집', ms: 'Penyuntingan kolaboratif', id: 'Penyuntingan kolaboratif', vi: 'Chỉnh sửa cộng tác', km: 'កែសម្រួលសហការ', my: 'ပူးပေါင်းတည်းဖြတ်ခြင်း', th: 'แก้ไขร่วมกัน' },
        '全局对讲机发声': { 'zh-Hant': '全域對講機發聲', en: 'Global intercom speaking', ja: '全体インカム発話', fr: 'Parler sur l’interphone global', ru: 'Говорить в общем интеркоме', es: 'Hablar por intercom global', it: 'Parlare nell’interfono globale', fa: 'صحبت در بی‌سیم سراسری', ko: '전체 인터컴 발화', ms: 'Bercakap interkom global', id: 'Berbicara interkom global', vi: 'Nói qua bộ đàm chung', km: 'និយាយក្នុងអាំងទែរកុមសកល', my: 'ကမ္ဘာလုံးဆိုင်ရာ အင်တာကွမ် စကားပြော', th: 'พูดผ่านอินเตอร์คอมส่วนกลาง' },
        '群语音通话': { 'zh-Hant': '群組語音通話', en: 'Group voice call', ja: 'グループ音声通話', fr: 'Appel vocal de groupe', ru: 'Групповой голосовой звонок', es: 'Llamada de voz grupal', it: 'Chiamata vocale di gruppo', fa: 'تماس صوتی گروهی', ko: '그룹 음성 통화', ms: 'Panggilan suara kumpulan', id: 'Panggilan suara grup', vi: 'Cuộc gọi thoại nhóm', km: 'ការហៅសំឡេងក្រុម', my: 'အုပ်စု အသံခေါ်ဆိုမှု', th: 'การโทรเสียงกลุ่ม' },
        '修改历史': { 'zh-Hant': '修改歷史', en: 'Edit history', ja: '編集履歴', fr: 'Historique des modifications', ru: 'История изменений', es: 'Historial de cambios', it: 'Cronologia modifiche', fa: 'تاریخچه ویرایش', ko: '수정 기록', ms: 'Sejarah suntingan', id: 'Riwayat edit', vi: 'Lịch sử chỉnh sửa', km: 'ប្រវត្តិកែប្រែ', my: 'တည်းဖြတ်မှတ်တမ်း', th: 'ประวัติการแก้ไข' },
        '富文本修改历史': { 'zh-Hant': '富文字修改歷史', en: 'Rich text edit history', ja: 'リッチテキスト編集履歴', fr: 'Historique du texte enrichi', ru: 'История форматированного текста', es: 'Historial de texto enriquecido', it: 'Cronologia testo avanzato', fa: 'تاریخچه ویرایش متن غنی', ko: '리치 텍스트 수정 기록', ms: 'Sejarah suntingan teks kaya', id: 'Riwayat edit rich text', vi: 'Lịch sử chỉnh sửa văn bản định dạng', km: 'ប្រវត្តិកែអត្ថបទសម្បូរបែប', my: 'ရစ်ချ်စာသား တည်းဖြတ်မှတ်တမ်း', th: 'ประวัติการแก้ไขข้อความแบบจัดรูปแบบ' },
        '关闭': { 'zh-Hant': '關閉', en: 'Close', ja: '閉じる', fr: 'Fermer', ru: 'Закрыть', es: 'Cerrar', it: 'Chiudi', fa: 'بستن', ko: '닫기', ms: 'Tutup', id: 'Tutup', vi: 'Đóng', km: 'បិទ', my: 'ပိတ်မည်', th: 'ปิด' },
        '保存修改': { 'zh-Hant': '儲存修改', en: 'Save changes', ja: '変更を保存', fr: 'Enregistrer les modifications', ru: 'Сохранить изменения', es: 'Guardar cambios', it: 'Salva modifiche', fa: 'ذخیره تغییرات', ko: '변경 사항 저장', ms: 'Simpan perubahan', id: 'Simpan perubahan', vi: 'Lưu thay đổi', km: 'រក្សាទុកការកែប្រែ', my: 'ပြင်ဆင်ချက်များ သိမ်းမည်', th: 'บันทึกการแก้ไข' },
        '下载全部': { 'zh-Hant': '全部下載', en: 'Download all', ja: 'すべてダウンロード', fr: 'Tout télécharger', ru: 'Скачать всё', es: 'Descargar todo', it: 'Scarica tutto', fa: 'دانلود همه', ko: '모두 다운로드', ms: 'Muat turun semua', id: 'Unduh semua', vi: 'Tải xuống tất cả', km: 'ទាញយកទាំងអស់', my: 'အားလုံးဒေါင်းလုဒ်', th: 'ดาวน์โหลดทั้งหมด' },
        '删除': { 'zh-Hant': '刪除', en: 'Delete', ja: '削除', fr: 'Supprimer', ru: 'Удалить', es: 'Eliminar', it: 'Elimina', fa: 'حذف', ko: '삭제', ms: 'Padam', id: 'Hapus', vi: 'Xóa', km: 'លុប', my: 'ဖျက်မည်', th: 'ลบ' },
        '取消': { 'zh-Hant': '取消', en: 'Cancel', ja: 'キャンセル', fr: 'Annuler', ru: 'Отмена', es: 'Cancelar', it: 'Annulla', fa: 'لغو', ko: '취소', ms: 'Batal', id: 'Batal', vi: 'Hủy', km: 'បោះបង់', my: 'မလုပ်တော့ပါ', th: 'ยกเลิก' },
        '插入': { 'zh-Hant': '插入', en: 'Insert', ja: '挿入', fr: 'Insérer', ru: 'Вставить', es: 'Insertar', it: 'Inserisci', fa: 'درج', ko: '삽입', ms: 'Masukkan', id: 'Sisipkan', vi: 'Chèn', km: 'បញ្ចូល', my: 'ထည့်သွင်းမည်', th: 'แทรก' },
        '引用文件': { 'zh-Hant': '引用檔案', en: 'Reference file', ja: 'ファイル参照', fr: 'Référencer un fichier', ru: 'Сослаться на файл', es: 'Referenciar archivo', it: 'Riferisci file', fa: 'ارجاع به فایل', ko: '파일 참조', ms: 'Rujuk fail', id: 'Referensikan file', vi: 'Tham chiếu tệp', km: 'យោងឯកសារ', my: 'ဖိုင် ကိုးကားရန်', th: 'อ้างอิงไฟล์' },
        '选择引用文件': { 'zh-Hant': '選擇引用檔案', en: 'Choose a referenced file', ja: '参照ファイルを選択', fr: 'Choisir un fichier référencé', ru: 'Выберите файл для ссылки', es: 'Elige un archivo referenciado', it: 'Scegli un file da riferire', fa: 'انتخاب فایل ارجاعی', ko: '참조할 파일 선택', ms: 'Pilih fail rujukan', id: 'Pilih file referensi', vi: 'Chọn tệp tham chiếu', km: 'ជ្រើសឯកសារយោង', my: 'ကိုးကားဖိုင် ရွေးပါ', th: 'เลือกไฟล์อ้างอิง' },
        '打开隧道设置': { 'zh-Hant': '開啟隧道設定', en: 'Open tunnel settings', ja: 'トンネル設定を開く', fr: 'Ouvrir les paramètres du tunnel', ru: 'Открыть настройки туннеля', es: 'Abrir ajustes del túnel', it: 'Apri impostazioni tunnel', fa: 'باز کردن تنظیمات تونل', ko: '터널 설정 열기', ms: 'Buka tetapan terowong', id: 'Buka pengaturan tunnel', vi: 'Mở cài đặt đường hầm', km: 'បើកការកំណត់ផ្លូវរូង', my: 'တန်နယ် ဆက်တင်များ ဖွင့်မည်', th: 'เปิดการตั้งค่าอุโมงค์' }
    };

    function normalizeLanguage(value) {
        const raw = String(value || '').toLowerCase();
        if (raw.startsWith('zh-tw') || raw.startsWith('zh-hk') || raw.includes('hant')) return 'zh-Hant';
        if (raw.startsWith('zh')) return 'zh-Hans';
        const direct = SUPPORTED_LANGUAGES.find(([code]) => code.toLowerCase() === raw);
        if (direct) return direct[0];
        const prefix = SUPPORTED_LANGUAGES.find(([code]) => raw.startsWith(code.toLowerCase().split('-')[0]));
        return prefix ? prefix[0] : DEFAULT_LANG;
    }

    function currentLanguage() {
        return normalizeLanguage(localStorage.getItem(STORAGE_KEY) || navigator.language || DEFAULT_LANG);
    }

    function translateText(source, lang = currentLanguage()) {
        const text = String(source || '');
        if (!text.trim() || lang === 'zh-Hans') return text;
        const entry = CORE[text.trim()];
        if (!entry) return text;
        return entry[lang] || entry.en || text;
    }

    function translateNode(root) {
        const lang = currentLanguage();
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
        const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || parent.closest('script, style, code, pre, textarea, [contenteditable="true"], .message, .rich-message-editor')) return NodeFilter.FILTER_REJECT;
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(node => {
            const original = node.__i18nSource || node.nodeValue.trim();
            if (!node.__i18nSource) node.__i18nSource = original;
            const translated = translateText(original, lang);
            const currentText = node.nodeValue.trim();
            if (currentText !== translated) node.nodeValue = node.nodeValue.replace(currentText, translated);
        });
        (root || document).querySelectorAll?.('[title], [placeholder], [aria-label]').forEach(el => {
            ['title', 'placeholder', 'aria-label'].forEach(attr => {
                if (!el.hasAttribute(attr)) return;
                const key = `__i18n_${attr}`;
                const original = el[key] || el.getAttribute(attr);
                if (!el[key]) el[key] = original;
                el.setAttribute(attr, translateText(original, lang));
            });
        });
        bindLanguageSelect(root || document);
    }

    function bindLanguageSelect(root) {
        const select = (root || document).querySelector?.('#appLanguageSelect');
        if (!select || select.dataset.i18nBound === 'true') return;
        select.dataset.i18nBound = 'true';
        select.replaceChildren();
        SUPPORTED_LANGUAGES.forEach(([code, label]) => select.add(new Option(label, code)));
        select.value = currentLanguage();
        select.addEventListener('change', () => setLanguage(select.value));
    }

    function setLanguage(lang) {
        const normalized = normalizeLanguage(lang);
        localStorage.setItem(STORAGE_KEY, normalized);
        translateNode(document.body);
        document.querySelectorAll('#appLanguageSelect').forEach(select => { select.value = normalized; });
        window.dispatchEvent(new CustomEvent('drop2tunnel-language-changed', { detail: { language: normalized } }));
    }

    let observer = null;
    function start() {
        translateNode(document.body);
        observer = new MutationObserver(records => {
            for (const record of records) {
                if (record.type === 'characterData' && record.target?.parentElement) {
                    translateNode(record.target.parentElement);
                    continue;
                }
                record.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) translateNode(node);
                    else if (node.nodeType === Node.TEXT_NODE && node.parentElement) translateNode(node.parentElement);
                });
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    window.TunnelI18n = {
        languages: SUPPORTED_LANGUAGES,
        currentLanguage,
        setLanguage,
        t: translateText,
        translate: translateNode,
        bindLanguageSelect
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
