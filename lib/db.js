// In-memory data store (survives HMR via globalThis). Seeded with demo data.

function seed() {
  const users = [
    // Demo accounts
    { id: "u1", email: "client@demo.sa", password: "demo1234", role: "client", name: "Sarah Al-Otaibi", nameAr: "سارة العتيبي", city: "riyadh", skills: [], hourlyRate: null, company: "Nakhla Tech", companyAr: "نخلة تك" },
    { id: "u2", email: "freelancer@demo.sa", password: "demo1234", role: "freelancer", name: "Mohammed Al-Qahtani", nameAr: "محمد القحطاني", city: "jeddah", skills: ["React", "Next.js", "Node.js", "UI/UX"], hourlyRate: 180, bio: "Full-stack developer with 6 years of experience building web apps for startups in the Gulf.", bioAr: "مطوّر متكامل بخبرة ٦ سنوات في بناء تطبيقات الويب للشركات الناشئة في الخليج." },
    // Extra clients
    { id: "u3", email: "layla@client.sa", password: "demo1234", role: "client", name: "Layla Al-Harbi", nameAr: "ليلى الحربي", city: "riyadh", skills: [], hourlyRate: null, company: "Sidra Retail", companyAr: "سدرة للتجزئة" },
    { id: "u4", email: "fahad@client.sa", password: "demo1234", role: "client", name: "Fahad Al-Dossari", nameAr: "فهد الدوسري", city: "dammam", skills: [], hourlyRate: null, company: "Sharq Logistics", companyAr: "شرق للخدمات اللوجستية" },
    // Extra freelancers
    { id: "u5", email: "noura@free.sa", password: "demo1234", role: "freelancer", name: "Noura Al-Shammari", nameAr: "نورة الشمري", city: "riyadh", skills: ["Branding", "Logo Design", "Illustrator"], hourlyRate: 150, bio: "Brand designer crafting visual identities for Saudi businesses.", bioAr: "مصممة هويات بصرية للأعمال السعودية." },
    { id: "u6", email: "khalid@free.sa", password: "demo1234", role: "freelancer", name: "Khalid Al-Mutairi", nameAr: "خالد المطيري", city: "makkah", skills: ["Copywriting", "Arabic Content", "SEO"], hourlyRate: 120, bio: "Bilingual copywriter for marketing campaigns.", bioAr: "كاتب محتوى ثنائي اللغة للحملات التسويقية." },
    { id: "u7", email: "amal@free.sa", password: "demo1234", role: "freelancer", name: "Amal Al-Zahrani", nameAr: "أمل الزهراني", city: "jeddah", skills: ["Flutter", "iOS", "Android"], hourlyRate: 200, bio: "Mobile engineer shipping apps used by 500k+ users.", bioAr: "مهندسة تطبيقات جوال تستخدم تطبيقاتها أكثر من ٥٠٠ ألف مستخدم." },
    { id: "u8", email: "yousef@free.sa", password: "demo1234", role: "freelancer", name: "Yousef Al-Ghamdi", nameAr: "يوسف الغامدي", city: "riyadh", skills: ["Video Editing", "Motion Graphics", "After Effects"], hourlyRate: 160, bio: "Motion designer for ads and social media.", bioAr: "مصمم موشن جرافيك للإعلانات ووسائل التواصل." },
  ];

  const projects = [
    { id: "p1", clientId: "u1", category: "development", city: "riyadh", budget: 15000, status: "open",
      title: "E-commerce website for dates & coffee brand", titleAr: "متجر إلكتروني لعلامة تمور وقهوة",
      desc: "Build a bilingual online store (Arabic/English) with product catalog, cart, and Mada/Apple Pay-ready checkout structure. Modern, fast, mobile-first.", descAr: "بناء متجر إلكتروني ثنائي اللغة (عربي/إنجليزي) مع كتالوج منتجات وسلة شراء وهيكل دفع جاهز لمدى وآبل باي. عصري وسريع ومتوافق مع الجوال.", createdAt: Date.now() - 86400000 * 2 },
    { id: "p2", clientId: "u1", category: "design", city: "riyadh", budget: 6000, status: "open",
      title: "Brand identity for a specialty coffee chain", titleAr: "هوية بصرية لسلسلة قهوة مختصة",
      desc: "Full visual identity: logo, colors, typography, packaging for cups and bags, and social media templates.", descAr: "هوية بصرية كاملة: شعار، ألوان، خطوط، تغليف للأكواب والأكياس، وقوالب لوسائل التواصل الاجتماعي.", createdAt: Date.now() - 86400000 * 3 },
    { id: "p3", clientId: "u3", category: "marketing", city: "riyadh", budget: 8000, status: "open",
      title: "Ramadan campaign for retail app", titleAr: "حملة رمضان لتطبيق تجزئة",
      desc: "Plan and run a 4-week Ramadan social campaign on X, Snapchat and TikTok targeting Saudi shoppers, with weekly performance reports.", descAr: "تخطيط وإدارة حملة رمضانية لمدة ٤ أسابيع على منصات إكس وسناب شات وتيك توك تستهدف المتسوقين في السعودية، مع تقارير أداء أسبوعية.", createdAt: Date.now() - 86400000 * 1 },
    { id: "p4", clientId: "u4", category: "development", city: "dammam", budget: 25000, status: "open",
      title: "Fleet tracking dashboard (React)", titleAr: "لوحة تتبع أسطول الشاحنات (React)",
      desc: "Real-time dashboard showing truck locations, delivery status and driver KPIs. API is ready; we need the frontend.", descAr: "لوحة تحكم لحظية تعرض مواقع الشاحنات وحالة التوصيل ومؤشرات أداء السائقين. الواجهة الخلفية جاهزة ونحتاج الواجهة الأمامية.", createdAt: Date.now() - 86400000 * 5 },
    { id: "p5", clientId: "u3", category: "writing", city: "jeddah", budget: 3500, status: "open",
      title: "Arabic product descriptions (200 SKUs)", titleAr: "كتابة أوصاف منتجات بالعربية (٢٠٠ منتج)",
      desc: "Write compelling Arabic descriptions for 200 fashion products, SEO-friendly, consistent tone of voice.", descAr: "كتابة أوصاف عربية جذابة لـ ٢٠٠ منتج أزياء، متوافقة مع محركات البحث وبنبرة موحّدة.", createdAt: Date.now() - 86400000 * 4 },
    { id: "p6", clientId: "u4", category: "translation", city: "khobar", budget: 2500, status: "open",
      title: "Translate logistics contracts EN→AR", titleAr: "ترجمة عقود لوجستية من الإنجليزية إلى العربية",
      desc: "Translate 40 pages of shipping and warehousing contracts into formal legal Arabic.", descAr: "ترجمة ٤٠ صفحة من عقود الشحن والتخزين إلى لغة عربية قانونية رسمية.", createdAt: Date.now() - 86400000 * 6 },
    { id: "p7", clientId: "u1", category: "video", city: "riyadh", budget: 9000, status: "open",
      title: "Launch video for mobile app", titleAr: "فيديو إطلاق لتطبيق جوال",
      desc: "60-second animated launch video with Arabic voice-over and English subtitles, vertical + horizontal cuts.", descAr: "فيديو إطلاق متحرك مدته ٦٠ ثانية مع تعليق صوتي عربي وترجمة إنجليزية، بنسختين عمودية وأفقية.", createdAt: Date.now() - 86400000 * 2.5 },
    { id: "p8", clientId: "u3", category: "design", city: "makkah", budget: 4000, status: "open",
      title: "UI redesign for booking app screens", titleAr: "إعادة تصميم واجهات تطبيق حجوزات",
      desc: "Redesign 12 key screens of an umrah services booking app in Figma with a clean modern look.", descAr: "إعادة تصميم ١٢ شاشة رئيسية لتطبيق حجز خدمات العمرة على فيقما بمظهر عصري ونظيف.", createdAt: Date.now() - 86400000 * 7 },
    { id: "p9", clientId: "u4", category: "development", city: "dammam", budget: 12000, status: "open",
      title: "Company website with CMS", titleAr: "موقع شركة مع نظام إدارة محتوى",
      desc: "Corporate website (AR/EN) with news section, careers page and simple CMS for the marketing team.", descAr: "موقع شركة (عربي/إنجليزي) مع قسم أخبار وصفحة وظائف ونظام إدارة محتوى بسيط لفريق التسويق.", createdAt: Date.now() - 86400000 * 8 },
    { id: "p10", clientId: "u1", category: "marketing", city: "jeddah", budget: 5000, status: "open",
      title: "SEO audit and 3-month plan", titleAr: "تدقيق SEO وخطة ٣ أشهر",
      desc: "Technical SEO audit for our store plus a keyword strategy for the Saudi market.", descAr: "تدقيق تقني لمتجرنا مع استراتيجية كلمات مفتاحية للسوق السعودي.", createdAt: Date.now() - 86400000 * 1.5 },
    { id: "p11", clientId: "u3", category: "writing", city: "riyadh", budget: 2000, status: "in_progress", acceptedProposalId: "pr4",
      title: "Blog articles about Saudi fashion trends", titleAr: "مقالات مدونة عن اتجاهات الموضة السعودية",
      desc: "8 Arabic blog articles (800 words each) about fashion trends and styling tips.", descAr: "٨ مقالات عربية (٨٠٠ كلمة لكل مقال) عن اتجاهات الموضة ونصائح التنسيق.", createdAt: Date.now() - 86400000 * 12 },
    { id: "p12", clientId: "u4", category: "video", city: "khobar", budget: 7000, status: "completed", acceptedProposalId: "pr5",
      title: "Warehouse safety training videos", titleAr: "فيديوهات تدريبية عن السلامة في المستودعات",
      desc: "Series of 5 short training videos with Arabic narration for warehouse staff.", descAr: "سلسلة من ٥ فيديوهات تدريبية قصيرة بتعليق صوتي عربي لموظفي المستودعات.", createdAt: Date.now() - 86400000 * 30 },
  ];

  const proposals = [
    { id: "pr1", projectId: "p1", freelancerId: "u7", amount: 14000, days: 30, status: "pending", createdAt: Date.now() - 86400000 * 1,
      cover: "I've built 6 bilingual stores for Saudi brands. I'll deliver a fast Next.js storefront with RTL support and a checkout structure ready for Mada." },
    { id: "pr2", projectId: "p2", freelancerId: "u5", amount: 5500, days: 14, status: "pending", createdAt: Date.now() - 86400000 * 2,
      cover: "Brand identity is my specialty — I've designed identities for 3 coffee brands in Riyadh. You'll get 3 logo concepts, full guidelines and packaging." },
    { id: "pr3", projectId: "p5", freelancerId: "u6", amount: 3200, days: 12, status: "pending", createdAt: Date.now() - 86400000 * 2,
      cover: "أكتب أوصاف منتجات متوافقة مع SEO بنبرة تناسب جمهور الأزياء. أسلّم ٢٠ وصفاً يومياً مع مراجعة لغوية." },
    { id: "pr4", projectId: "p11", freelancerId: "u6", amount: 1800, days: 20, status: "accepted", createdAt: Date.now() - 86400000 * 11,
      cover: "سأكتب مقالات أصلية مدعومة بالكلمات المفتاحية الأكثر بحثاً في السعودية." },
    { id: "pr5", projectId: "p12", freelancerId: "u8", amount: 6500, days: 21, status: "accepted", createdAt: Date.now() - 86400000 * 28,
      cover: "Motion graphics + Arabic narration recorded in studio. Storyboards within 3 days." },
  ];

  return { users, projects, proposals, nextId: 100 };
}

export function db() {
  if (!globalThis.__khedmaDb) globalThis.__khedmaDb = seed();
  return globalThis.__khedmaDb;
}

export function newId(prefix) {
  const d = db();
  return `${prefix}${d.nextId++}`;
}

export const CATEGORIES = ["development", "design", "writing", "marketing", "translation", "video"];
export const CITIES = ["riyadh", "jeddah", "makkah", "madinah", "dammam", "khobar", "abha", "tabuk"];

export const findUser = (id) => db().users.find((u) => u.id === id);
export const findProject = (id) => db().projects.find((p) => p.id === id);
export const proposalsFor = (projectId) => db().proposals.filter((p) => p.projectId === projectId);
