const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// =========================================================
// DATABASE 1: Specific Products (Expanded & Multilingual)
// =========================================================
const bisDatabase = {
    "patanjali biscuit": {
        en: {
            productName: "Patanjali Doodh Biscuits",
            manufacturer: "Patanjali Ayurved Ltd.",
            standard: "IS 1011:2002 (Biscuits Specification)",
            licenseNumber: "CM/L-9876543210",
            status: "Active",
            validUpto: "2027-03-31",
            mandatory: "Voluntary (Mandatory for Government Procurement)",
            testingParams: "Moisture Content (max 6.0%), Acid Insoluble Ash (max 0.05%), Peroxide Value, Acidity of Extracted Fat, Microbial Count.",
            details: "Complies with quality standards for raw wheat flour, edible fats, and food-grade sweetening agents."
        },
        hi: {
            productName: "पतंजलि दूध बिस्किट",
            manufacturer: "पतंजलि आयुर्वेद लिमिटेड",
            standard: "IS 1011:2002 (बिस्कुट विशिष्टता)",
            licenseNumber: "CM/L-9876543210",
            status: "सक्रिय (Active)",
            validUpto: "31-03-2027",
            mandatory: "ऐच्छिक (सरकारी खरीद के लिए अनिवार्य)",
            testingParams: "नमी की मात्रा (अधिकतम 6.0%), एसिड अघुलनशील राख, पेरोक्साइड मान, माइक्रोबियल सीमाएं।",
            details: "कच्चे गेहूं के आटे, खाद्य वसा और खाद्य-ग्रेड मीठे एजेंटों के गुणवत्ता मानकों का अनुपालन करता है।"
        },
        pa: {
            productName: "ਪਤੰਜਲੀ ਦੁੱਧ ਬਿਸਕੁਟ",
            manufacturer: "ਪਤੰਜਲੀ ਆਯੁਰਵੇਦ ਲਿਮਟਿਡ",
            standard: "IS 1011:2002 (ਬਿਸਕੁਟ ਨਿਰਧਾਰਨ)",
            licenseNumber: "CM/L-9876543210",
            status: "ਸਰਗਰਮ (Active)",
            validUpto: "31-03-2027",
            mandatory: "ਮਰਜ਼ੀ ਮੁਤਾਬਕ (ਸਰਕਾਰੀ ਖਰੀਦ ਲਈ ਲਾਜ਼ਮੀ)",
            testingParams: "ਨਮੀ ਦੀ ਮਾਤਰਾ (ਅਧਿਕਤਮ 6.0%), ਐਸਿਡ ਅਘੁਲਣਸ਼ੀਲ ਰਾਖ, ਮਾਈਕ੍ਰੋਬਾਇਲ ਸੀਮਾਵਾਂ।",
            details: "ਕਣਕ ਦੇ ਆਟੇ ਅਤੇ ਖਾਣ ਵਾਲੇ ਤੇਲ ਦੇ ਸਾਰੇ ਗੁਣਵੱਤਾ ਮਾਪਦੰਡਾਂ ਨੂੰ ਪੂਰਾ ਕਰਦਾ ਹੈ।"
        },
        te: {
            productName: "పతంజలి దూద్ బిస్కెట్లు",
            manufacturer: "పతంజలి ఆయుర్వేద్ లిమిటెడ్",
            standard: "IS 1011:2002 (బిస్కెట్ల స్పెసిఫికేషన్)",
            licenseNumber: "CM/L-9876543210",
            status: "యాక్టివ్ (Active)",
            validUpto: "31-03-2027",
            mandatory: "స్వేచ్ఛాపూరితం (ప్రభుత్వ సేకరణకు తప్పనిసరి)",
            testingParams: "తేమ శాతం (గరిష్టంగా 6.0%), ఆమ్ల అకరిగే బూడిద, మైక్రోబియల్ పరిమితులు.",
            details: "గోధుమ పిండి మరియు ఆహార నాణ్యత పారామితులకు కట్టుబడి ఉంటుంది."
        }
    },
    "bajaj bulb": {
        en: {
            productName: "Bajaj LED Bulb (9W)",
            manufacturer: "Bajaj Electricals Ltd.",
            standard: "IS 16102 (Part 1):2012 / IS 16102 (Part 2):2016",
            licenseNumber: "R-12345678",
            status: "Active",
            validUpto: "2026-12-31",
            mandatory: "Yes (Compulsory Registration Scheme - CRS)",
            testingParams: "Insulation Resistance, Electric Strength, Photo-biological Safety, Harmonic Current Emissions, Heat Resistance.",
            details: "Complies with compulsory electronic safety standards to prevent electrical shock, overheating, and optical radiation hazards."
        },
        hi: {
            productName: "बजाज एलईडी बल्ब (9W)",
            manufacturer: "बजाज इलेक्ट्रिकल्स लिमिटेड",
            standard: "IS 16102 (भाग 1):2012 / IS 16102 (भाग 2):2016",
            licenseNumber: "R-12345678",
            status: "सक्रिय (Active)",
            validUpto: "31-12-2026",
            mandatory: "हां (अनिवार्य पंजीकरण योजना - CRS)",
            testingParams: "इन्सुलेशन प्रतिरोध, विद्युत शक्ति, फोटो-बायोलॉजिकल सुरक्षा, गर्मी प्रतिरोध।",
            details: "बिजली के झटके, ओवरहीटिंग और प्रकाश विकिरण के खतरों को रोकने के लिए अनिवार्य इलेक्ट्रॉनिक सुरक्षा मानकों का पालन करता है।"
        },
        pa: {
            productName: "ਬਜਾਜ LED ਬਲਬ (9W)",
            manufacturer: "ਬਜਾਜ ਇਲੈਕਟ੍ਰੀਕਲਜ਼ ਲਿਮਟਿਡ",
            standard: "IS 16102 (ਭਾਗ 1):2012 / IS 16102 (ਭਾਗ 2):2016",
            licenseNumber: "R-12345678",
            status: "ਸਰਗਰਮ (Active)",
            validUpto: "31-12-2026",
            mandatory: "ਹਾਂ (ਲਾਜ਼ਮੀ ਰਜਿਸਟ੍ਰੇਸ਼ਨ ਸਕੀਮ - CRS)",
            testingParams: "ਇਨਸੂਲੇਸ਼ਨ ਪ੍ਰਤੀਰੋਧ, ਬਿਜਲੀ ਦੀ ਤਾਕਤ, ਗਰਮੀ ਪ੍ਰਤੀਰੋਧ, ਪ੍ਰਕਾਸ਼ ਸੁਰੱਖਿਆ।",
            details: "ਬਿਜਲੀ ਦੇ ਝਟਕੇ ਅਤੇ ਓਵਰਹੀਟਿੰਗ ਨੂੰ ਰੋਕਣ ਲਈ ਲਾਜ਼ਮੀ ਸੁਰੱਖਿਆ ਮਾਪਦੰਡਾਂ ਦੀ ਪਾਲਣਾ ਕਰਦਾ ਹੈ।"
        },
        te: {
            productName: "బజాజ్ LED బల్బ్ (9W)",
            manufacturer: "బజాజ్ ఎలక్ట్రికల్స్ లిమిటెਡ",
            standard: "IS 16102 (పార్ట్ 1):2012 / IS 16102 (పార్ట్ 2):2016",
            licenseNumber: "R-12345678",
            status: "యాక్టివ్ (Active)",
            validUpto: "31-12-2026",
            mandatory: "అవును (తప్పనిసరి నమోదు పథకం - CRS)",
            testingParams: "ఇన్సులేషన్ నిరోధకత, విద్యుత్ బలం, ఉష్ణ నిరోధకత, కాంతి భద్రత.",
            details: "విద్యుత్ షాక్ మరియు వేడిని నివారించడానికి తప్పనిసరి ఎలక్ట్రానిక్ భద్రతా ప్రమాణాలకు అనుగుణంగా ఉంటుంది."
        }
    },

    "kitkat chocolate": {
        en: {
            productName: "Nestlé KitKat Chocolate",
            manufacturer: "Nestlé India Ltd.",
            standard: "IS 1163:1992 (Chocolates - Specification)",
            licenseNumber: "CM/L-8765432109",
            status: "Active",
            validUpto: "2025-12-31",
            mandatory: "Voluntary (FSSAI is mandatory, BIS is voluntary for chocolates)",
            testingParams: "Cocoa solids content, milk fat, moisture, total ash, and microbiological safety limits.",
            details: "Complies with quality standards for cocoa butter, sugar, and milk powder used in chocolate manufacturing."
        },
        hi: {
            productName: "नेस्ले किटकैट चॉकलेट",
            manufacturer: "नेस्ले इंडिया लिमिटेड",
            standard: "IS 1163:1992 (चॉकलेट - विशिष्टता)",
            licenseNumber: "CM/L-8765432109",
            status: "सक्रिय (Active)",
            validUpto: "31-12-2025",
            mandatory: "ऐच्छिक (FSSAI अनिवार्य है, BIS ऐच्छिक है)",
            testingParams: "कोको ठोस सामग्री, दूध वसा, नमी, कुल राख, और सूक्ष्मजीवविज्ञानी सुरक्षा सीमाएं।",
            details: "चॉकलेट निर्माण में उपयोग किए जाने वाले कोकोआ मक्खन, चीनी और दूध पाउडर के गुणवत्ता मानकों का अनुपालन करता है।"
        },
        pa: {
            productName: "ਨੈਸਲੇ ਕਿਟਕੈਟ ਚਾਕਲੇਟ",
            manufacturer: "ਨੈਸਲੇ ਇੰਡੀਆ ਲਿਮਟਿਡ",
            standard: "IS 1163:1992 (ਚਾਕਲੇਟ - ਨਿਰਧਾਰਨ)",
            licenseNumber: "CM/L-8765432109",
            status: "ਸਰਗਰਮ (Active)",
            validUpto: "31-12-2025",
            mandatory: "ਮਰਜ਼ੀ ਮੁਤਾਬਕ (FSSAI ਲਾਜ਼ਮੀ ਹੈ, BIS ਮਰਜ਼ੀ ਮੁਤਾਬਕ ਹੈ)",
            testingParams: "ਕੋਕੋ ਠੋਸ ਸਮੱਗਰੀ, ਦੁੱਧ ਦੀ ਚਰਬੀ, ਨਮੀ, ਅਤੇ ਮਾਈਕ੍ਰੋਬਾਇਓਲੋਜੀਕਲ ਸੁਰੱਖਿਆ।",
            details: "ਚਾਕਲੇਟ ਬਣਾਉਣ ਲਈ ਵਰਤੇ ਜਾਂਦੇ ਕੋਕੋ ਮੱਖਣ, ਖੰਡ ਅਤੇ ਦੁੱਧ ਪਾਊਡਰ ਦੇ ਗੁਣਵੱਤਾ ਮਾਪਦੰਡਾਂ ਦੀ ਪਾਲਣਾ ਕਰਦਾ ਹੈ।"
        },
        te: {
            productName: "నెస్లే కిట్‌క్యాట్ చాక్లెట్",
            manufacturer: "నెస్లే ఇండియా లిమిటెడ్",
            standard: "IS 1163:1992 (చాక్లెట్లు - స్పెసిఫికేషన్)",
            licenseNumber: "CM/L-8765432109",
            status: "యాక్టివ్ (Active)",
            validUpto: "31-12-2025",
            mandatory: "స్వేచ్ఛాపూరితం (FSSAI తప్పనిసరి, BIS స్వేచ్ఛాపూరితం)",
            testingParams: "కోకో ఘనపదార్థాలు, పాల కొవ్వు, తేమ, మరియు మైక్రోబయోలాజికల్ భద్రతా పరిమితులు.",
            details: "చాక్లెట్ తయారీలో ఉపయోగించే కోకో బటర్, చక్కెర మరియు పాల పొడి నాణ్యతా ప్రమాణాలకు అనుగుణంగా ఉంటుంది."
        }
    },

    "ambuja cement": {
        en: {
            productName: "Ambuja Portland Pozzolana Cement (PPC)",
            manufacturer: "Ambuja Cements Ltd.",
            standard: "IS 1489 (Part 1):2015",
            licenseNumber: "CM/L-1122334455",
            status: "Active",
            validUpto: "2028-05-31",
            mandatory: "Yes (Mandatory ISI Mark Certification Scheme)",
            testingParams: "Compressive Strength (3, 7, and 28 days), Setting Time (Initial & Final), Fineness (Blaine's Air Permeability), Soundness (Le-Chatelier expansion).",
            details: "Ensures structural strength, sulfate resistance, and low heat of hydration for load-bearing construction."
        },
        hi: {
            productName: "अंबुजा पोर्टलैंड पॉज़ोलाना सीमेंट (PPC)",
            manufacturer: "अंबुजा सीमेंट्स लिमिटेड",
            standard: "IS 1489 (भाग 1):2015",
            licenseNumber: "CM/L-1122334455",
            status: "सक्रिय (Active)",
            validUpto: "31-05-2028",
            mandatory: "हां (अनिवार्य आईएसआई मार्क योजना)",
            testingParams: "संपीडन शक्ति (Compressive Strength), जमने का समय (Setting Time), महीनता (Fineness), विस्तार परीक्षण।",
            details: "मजबूत निर्माण, सल्फेट प्रतिरोध और स्थायित्व के लिए अनिवार्य गुणवत्ता मापदंडों को पूरा करता है।"
        },
        pa: {
            productName: "ਅੰਬੂਜਾ ਪੋਰਟਲੈਂਡ ਪੋਜ਼ੋਲਾਨਾ ਸੀਮੈਂਟ (PPC)",
            manufacturer: "ਅੰਬੂਜਾ ਸੀਮੈਂਟਸ ਲਿਮਟਿਡ",
            standard: "IS 1489 (ਭਾਗ 1):2015",
            licenseNumber: "CM/L-1122334455",
            status: "ਸਰਗਰਮ (Active)",
            validUpto: "31-05-2028",
            mandatory: "ਹਾਂ (ਲਾਜ਼ਮੀ ISI ਮਾਰਕ ਸਕੀਮ)",
            testingParams: "ਕੰਪਰੈਸਿਵ ਤਾਕਤ, ਸੈੱਟਿੰਗ ਸਮਾਂ, ਬਾਰੀਕੀ ਅਤੇ ਟਿਕਾਊਤਾ ਪਰੀਖਣ।",
            details: "ਮਜ਼ਬੂਤ ਉਸਾਰੀ ਅਤੇ ਲੰਬੀ ਉਮਰ ਲਈ ਸਾਰੇ ਮਾਪਦੰਡ ਪੂਰੇ ਕਰਦਾ ਹੈ।"
        },
        te: {
            productName: "అంబుజా పోర్ట్‌లాండ్ పోజోలానా సిమెంట్ (PPC)",
            manufacturer: "అంబుజా సిమెంట్స్ లిమిటెਡ",
            standard: "IS 1489 (పార్ట్ 1):2015",
            licenseNumber: "CM/L-1122334455",
            status: "యాక్టివ్ (Active)",
            validUpto: "31-05-2028",
            mandatory: "అవును (తప్పనిసరి ISI మార్క్)",
            testingParams: "కంప్రెసివ్ బలం (Compressive Strength), సెట్టింగ్ సమయం, ఫైన్‌నెస్.",
            details: "భవన నిర్మాణం యొక్క బలం మరియు మన్నిక కోసం తప్పనిసరి నాణ్యతా ప్రమాణాలను కలిగి ఉంటుంది."
        }
    }
};

// =========================================================
// DATABASE 2: Standards Directory (Expanded & Multilingual)
// =========================================================
const standardsDatabase = {
    "is 302": {
        en: {
            code: "IS 302 (Part 1)",
            title: "Safety of Household and Similar Electrical Appliances",
            description: "Covers general mechanical and electrical safety requirements for household appliances (irons, water heaters, room heaters) to protect against electric shocks, burns, and fire hazards.",
            mandatory: "Yes (Mandatory under Quality Control Orders)",
            keyRequirements: "Leakage current limitations, dielectric strength, resistance to heat and fire, moisture resistance."
        },
        hi: {
            code: "IS 302 (भाग 1)",
            title: "घरेलू और समान विद्युत उपकरणों की सुरक्षा",
            description: "बिजली के झटके, जलने और आग के खतरों से सुरक्षा के लिए घरेलू उपकरणों (गीजर, हीटर, आयरन) के लिए सुरक्षा मानक।",
            mandatory: "हां (गुणवत्ता नियंत्रण आदेशों के तहत अनिवार्य)",
            keyRequirements: "लीकेज करंट सीमा, डाइइलेक्ट्रिक शक्ति, गर्मी और आग के प्रति प्रतिरोध।"
        },
        pa: {
            code: "IS 302 (ਭਾਗ 1)",
            title: "ਘਰੇਲੂ ਬਿਜਲੀ ਦੇ ਉਪਕਰਨਾਂ ਦੀ ਸੁਰੱਖਿਆ",
            description: "ਬਿਜਲੀ ਦੇ ਝਟਕੇ ਅਤੇ ਅੱਗ ਦੇ ਖਤਰਿਆਂ ਤੋਂ ਬਚਾਅ ਲਈ ਘਰੇਲੂ ਉਪਕਰਣਾਂ (ਹੀਟਰ, ਪ੍ਰੈਸ, ਗੀਜ਼ਰ) ਲਈ ਲਾਜ਼ਮੀ ਸੁਰੱਖਿਆ ਨਿਯਮ।",
            mandatory: "ਹਾਂ (ਲਾਜ਼ਮੀ)",
            keyRequirements: "ਲੀਕੇਜ ਕਰੰਟ ਸੀਮਾਵਾਂ, ਗਰਮੀ ਅਤੇ ਅੱਗ ਤੋਂ ਸੁਰੱਖਿਆ।"
        },
        te: {
            code: "IS 302 (పార్ట్ 1)",
            title: "గృహ విద్యుత్ ఉపకరణాల భద్రత",
            description: "విద్యుత్ షాక్‌లు మరియు అగ్ని ప్రమాదాల నుండి రక్షణ కోసం గృహ ఉపకరణాల (హీటర్లు, ఇస్త్రీ పెట్టెలు) భద్రతా నిబంధనలు.",
            mandatory: "అవును (తప్పనిసరి)",
            keyRequirements: "లీకేజ్ కరెంట్ పరిమితులు, వేడి మరియు అగ్ని నిరోధకత."
        }
    },
    "is 1011": {
        en: {
            code: "IS 1011:2002",
            title: "Biscuits - Specification",
            description: "Prescribes requirements, sampling methods, and quality standards for all varieties of baked biscuits.",
            mandatory: "Voluntary (Mandatory for defense/canteen supplies)",
            keyRequirements: "Acidity of extracted fat, moisture content (max 6.0%), acid-insoluble ash limit."
        },
        hi: {
            code: "IS 1011:2002",
            title: "बिस्किट - विशिष्टता",
            description: "सभी प्रकार के पके हुए बिस्कुटों के लिए गुणवत्ता मानक, नमूनाकरण पद्धतियां और आवश्यकताएं।",
            mandatory: "ऐच्छिक (सरकारी आपूर्ति के लिए अनिवार्य)",
            keyRequirements: "नमी की मात्रा (अधिकतम 6.0%), पेरोक्साइड मान, एसिड अघुलनशील राख।"
        },
        pa: {
            code: "IS 1011:2002",
            title: "ਬਿਸਕੁਟ - ਨਿਰਧਾਰਨ",
            description: "ਸਾਰੇ ਪ੍ਰਕਾਰ ਦੇ ਬਿਸਕੁਟਾਂ ਲਈ ਗੁਣਵੱਤਾ ਦੇ ਮਾਪਦੰਡ ਅਤੇ ਪਰੀਖਣ ਨਿਯਮ।",
            mandatory: "ਮਰਜ਼ੀ ਮੁਤਾਬਕ",
            keyRequirements: "ਨਮੀ ਦੀ ਮਾਤਰਾ (ਅਧਿਕਤਮ 6.0%), ਐਸਿਡ ਅਘੁਲਣਸ਼ੀਲ ਰਾਖ।"
        },
        te: {
            code: "IS 1011:2002",
            title: "బిస్కెట్లు - స్పెసిఫికేషన్",
            description: "అన్ని రకాల బిస్కెట్ల తయారీ మరియు నాణ్యతా ప్రమాణాల వివరాలు.",
            mandatory: "స్వేచ్ఛాపూరితం",
            keyRequirements: "తేమ శాతం (గరిష్టంగా 6.0%), ఆమ్ల పరిమితులు."
        }
    },
    "is 14543": {
        en: {
            code: "IS 14543:2024",
            title: "Packaged Drinking Water (Other than Natural Mineral Water)",
            description: "Specifies hygiene, processing, filtration, and safety parameters for packaged drinking water sold in containers.",
            mandatory: "Yes (Strict mandatory ISI mark requirement)",
            keyRequirements: "Microbiological testing (Zero E. coli), heavy metal limits (Lead, Arsenic), pesticide residue standards, total dissolved solids (TDS)."
        },
        hi: {
            code: "IS 14543:2024",
            title: "पैकेजबंद पेयजल (प्राकृतिक खनिज जल को छोड़कर)",
            description: "बोतलबंद और पैकेजबंद पीने के पानी के लिए स्वच्छता, प्रसंस्करण और सुरक्षा मापदंड निर्धारित करता है।",
            mandatory: "हां (सख्त अनिवार्य आईएसआई मार्क आवश्यक)",
            keyRequirements: "माइक्रोबायोलॉजिकल परीक्षण (शून्य ई. कोलाई), भारी धातु सीमाएं (सीसा, आर्सेनिक), कीटनाशक अवशेष मानक।"
        },
        pa: {
            code: "IS 14543:2024",
            title: "ਪੈਕ ਕੀਤਾ ਪੀਣ ਵਾਲਾ ਪਾਣੀ",
            description: "ਬੋਤਲਬੰਦ ਪੀਣ ਵਾਲੇ ਪਾਣੀ ਦੀ ਸੁਰੱਖਿਆ, ਸਫਾਈ ਅਤੇ ਪਰੀਖਣ ਲਈ ਲਾਜ਼ਮੀ ਮਾਪਦੰਡ।",
            mandatory: "ਹਾਂ (ਲਾਜ਼ਮੀ ISI ਮਾਰਕ)",
            keyRequirements: "ਜੀਵਾਣੂ ਮੁਕਤ ਪਾਣੀ (ਜ਼ੀਰੋ ਈ. ਕੋਲਾਈ), ਭਾਰੀ ਧਾਤਾਂ ਦੀ ਸੀਮਾ।"
        },
        te: {
            code: "IS 14543:2024",
            title: "ప్యాకేజ్డ్ డ్రింకింగ్ వాటర్",
            description: "ప్యాక్ చేయబడిన మంచి నీటి పరిశుభ్రత మరియు భద్రతా నిబంధనలు.",
            mandatory: "అవును (తప్పనిసరి ISI మార్క్)",
            keyRequirements: "రసాయన మరియు మైక్రోబయోలాజికల్ పరీక్షలు, భార లోహాల పరిమితులు."
        }
    },
    "is 1293": {
        en: {
            code: "IS 1293:2019",
            title: "Plugs and Socket-Outlets up to 250 Volts and Rated Current up to 16 Amperes",
            description: "Covers safety dimensions, contact resistance, and shock-proofing for domestic electrical plugs and sockets.",
            mandatory: "Yes (Mandatory ISI Mark)",
            keyRequirements: "Dimensions precision, socket shutter safety, grounding effectiveness, temperature rise limits."
        },
        hi: {
            code: "IS 1293:2019",
            title: "250 वोल्ट तक के प्लग और सॉकेट-आउटलेट",
            description: "घरेलू प्लग और सॉकेट के लिए सुरक्षा आयाम, संपर्क प्रतिरोध और शॉक-प्रूफिंग मानक।",
            mandatory: "हां (अनिवार्य आईएसआई मार्क)",
            keyRequirements: "सॉकेट शटर सुरक्षा, अर्थिंग प्रभावशीलता, तापमान वृद्धि सीमा।"
        },
        pa: {
            code: "IS 1293:2019",
            title: "ਬਿਜਲੀ ਦੇ ਪਲੱਗ ਅਤੇ ਸਾਕਟ",
            description: "ਘਰੇਲੂ ਬਿਜਲੀ ਦੇ ਪਲੱਗਾਂ ਅਤੇ ਸਾਕਟਾਂ ਲਈ ਸੁਰੱਖਿਆ ਅਤੇ ਆਕਾਰ ਦੇ ਮਾਪਦੰਡ।",
            mandatory: "ਹਾਂ (ਲਾਜ਼ਮੀ ISI ਮਾਰਕ)",
            keyRequirements: "ਸ਼ੌਕ-ਪ੍ਰੂਫਿੰਗ, ਅਰਥਿੰਗ ਅਤੇ ਤਾਪਮਾਨ ਨਿਯੰਤਰਣ।"
        },
        te: {
            code: "IS 1293:2019",
            title: "ప్లగ్స్ మరియు సాకెట్లు",
            description: "గృహ విద్యుత్ ప్లగ్‌లు మరియు సాకెట్ల భద్రతా కొలతలు మరియు షాక్-ప్రూఫింగ్ ప్రమాణాలు.",
            mandatory: "అవును (తప్పనిసరి)",
            keyRequirements: "సాకెట్ షట్టర్ భద్రత, ఎర్తింగ్ విధానం."
        }
    }
};

// =========================================================
// MULTILINGUAL GENERIC RESPONSES
// =========================================================
const responses = {
    certification: {
        en: "<b>BIS Certification Steps (ISI Mark):</b><br>1. Identify the applicable Indian Standard (IS Code).<br>2. Submit application via the e-BIS portal (Manakonline).<br>3. Factory inspection and sample testing in BIS-approved labs.<br>4. Grant of License upon meeting standard specifications.",
        hi: "<b>BIS प्रमाणन चरण (ISI मार्क):</b><br>1. लागू भारतीय मानक (IS कोड) की पहचान करें।<br>2. e-BIS पोर्टल (Manakonline) के माध्यम से आवेदन जमा करें।<br>3. BIS-स्वीकृत प्रयोगशालाओं में कारखाना निरीक्षण और नमूना परीक्षण।<br>4. मानकों को पूरा करने पर लाइसेंस प्रदान करना।",
        pa: "<b>BIS ਸਰਟੀਫਿਕੇਸ਼ਨ ਪ੍ਰਕਿਰਿਆ (ISI ਮਾਰਕ):</b><br>1. ਢੁਕਵੇਂ ਭਾਰਤੀ ਮਾਪਦੰਡ (IS ਕੋਡ) ਦੀ ਪਛਾਣ ਕਰੋ।<br>2. e-BIS ਪੋਰਟਲ ਰਾਹੀਂ ਅਰਜ਼ੀ ਦਿਓ।<br>3. ਫੈਕਟਰੀ ਨਿਰੀਖਣ ਅਤੇ ਪ੍ਰਯੋਗਸ਼ਾਲਾ ਪਰੀਖਣ।<br>4. ਮਾਪਦੰਡ ਪੂਰੇ ਹੋਣ 'ਤੇ ਲਾਇਸੰਸ ਜਾਰੀ ਕਰਨਾ।",
        te: "<b>BIS సర్టిఫికేషన్ ప్రక్రియ (ISI మార్క్):</b><br>1. వర్తించే భారతీయ ప్రమాణాన్ని (IS కోడ్) గురితించండి.<br>2. e-BIS పోర్టల్ ద్వారా దరఖాస్తు చేయండి.<br>3. ఫ్యాక్టరీ తనిఖీ మరియు నమూనా పరీక్షలు.<br>4. నాణ్యత నిర్ధారణ తర్వాత లైసెన్స్ మంజూరు."
    },
    hallmarking: {
        en: "<b>BIS Gold Hallmarking Rules:</b><br>Mandatory for gold jewelry sales in India. Must include 3 key marks:<br>• <b>BIS Logo</b> (Triangular mark)<br>• <b>Purity Grade</b> (e.g., 22K916 = 22 Karat, 18K750 = 18 Karat)<br>• <b>6-digit HUID Code</b> (Unique alphanumeric Hallmark Unique Identification Number).",
        hi: "<b>BIS स्वर्ण हॉलमार्किंग नियम:</b><br>भारत में सोने के आभूषणों की बिक्री के लिए अनिवार्य। 3 प्रमुख चिह्न होने चाहिए:<br>• <b>BIS लोगो</b> (त्रिभुज चिह्न)<br>• <b>शुद्धता ग्रेड</b> (जैसे 22K916 = 22 कैरेट, 18K750 = 18 कैरेट)<br>• <b>6-अंकीय HUID कोड</b> (विशिष्ट हॉलमार्क विशिष्ट पहचान संख्या)।",
        pa: "<b>BIS ਸੋਨੇ ਦੀ ਹਾਲਮਾਰਕਿੰਗ ਦੇ ਨਿਯਮ:</b><br>ਭਾਰਤ ਵਿੱਚ ਸੋਨੇ ਦੇ ਗਹਿਣਿਆਂ ਲਈ ਲਾਜ਼ਮੀ। 3 ਮੁੱਖ ਨਿਸ਼ਾਨ ਹੋਣੇ ਚਾਹੀਦੇ ਹਨ:<br>• <b>BIS ਲੋਗੋ</b><br>• <b>ਸ਼ੁੱਧਤਾ ਗ੍ਰੇਡ</b> (ਜਿਵੇਂ 22K916 = 22 ਕੈਰੇਟ)<br>• <b>6-ਅੰਕਾਂ ਦਾ HUID ਕੋਡ</b>।",
        te: "<b>BIS బంగారు హాల్‌మార్కింగ్ నిబంధనలు:</b><br>భారతదేశంలో బంగారు ఆభరణాలకు తప్పనిసరి. 3 ముఖ్య గుర్తులు ఉండాలి:<br>• <b>BIS లోగో</b><br>• <b>పరిశుద్ధత గ్రేడ్</b> (ఉదా. 22K916 = 22 క్యారెట్లు)<br>• <b>6-అంకెల HUID కోడ్</b>."
    },
    fallback: {
        en: "I specialize in Indian Standards (IS Codes), BIS certifications, and Hallmarking. You can search for products (e.g., 'Patanjali biscuit', 'Ambuja cement', 'Bajaj bulb') or standard codes (e.g., 'IS 302', 'IS 14543').",
        hi: "मैं भारतीय मानकों (IS कोड), BIS प्रमाणन और हॉलमार्किंग में विशेषज्ञ हूँ। आप उत्पादों (जैसे 'पतंजलि बिस्किट', 'अंबुजा सीमेंट', 'बजाज बल्ब') या मानक कोड (जैसे 'IS 302', 'IS 14543') की खोज कर सकते हैं।",
        pa: "ਮੈਂ ਭਾਰਤੀ ਮਾਪਦੰਡਾਂ (IS ਕੋਡ) ਅਤੇ BIS ਸਰਟੀਫਿਕੇਸ਼ਨ ਵਿੱਚ ਮਾਹਰ ਹਾਂ। ਤੁਸੀਂ ਉਤਪਾਦਾਂ ਜਾਂ IS ਕੋਡਾਂ ਬਾਰੇ ਪੁੱਛ ਸਕਦੇ ਹੋ।",
        te: "నేను భారతీయ ప్రమాణాలు (IS కోడ్‌లు), BIS సర్టిఫికేషన్ మరియు హాల్‌మార్కింగ్‌లో ప్రత్యేకత కలిగి ఉన్నాను. మీరు ఉత్పత్తులు లేదా IS కోడ్‌ల గురించి శోధించవచ్చు."
    }
};

// =========================================================
// MAIN CHAT API ROUTE
// =========================================================
app.post('/api/chat', (req, res) => {
    try {
        const { query, lang = 'en' } = req.body || {};

        // Validating language code with English fallback
        const selectedLang = ['en', 'hi', 'pa', 'te'].includes(lang) ? lang : 'en';

        if (!query || typeof query !== 'string') {
            return res.status(400).json({ answer: responses.fallback[selectedLang] });
        }

        const lowerQuery = query.toLowerCase().trim();

        // 1. IS Code Search Matcher (e.g., "IS 302", "IS14543", "tell me about IS 1293")
        const stdMatch = lowerQuery.match(/\bis\s?(\d+)\b/);
        if (stdMatch) {
            const standardKey = `is ${stdMatch[1]}`;
            if (standardsDatabase[standardKey]) {
                const std = standardsDatabase[standardKey][selectedLang] || standardsDatabase[standardKey]['en'];
                const responseHTML = `
                    <b>Standard:</b> <span style="color: #1a56b5; font-size: 16px;">${std.code}</span><br><br>
                    • <b>Title:</b> ${std.title}<br>
                    • <b>Mandatory Compliance:</b> <span style="color: #10b981; font-weight: bold;">${std.mandatory}</span><br><br>
                    • <b>Key Testing Parameters:</b> ${std.keyRequirements}<br><br>
                    <i>Description:</i> ${std.description}
                `;
                return res.json({ answer: responseHTML });
            }
        }

        // 2. Specific Product Matcher
        let productKeyFound = null;
        if (lowerQuery.includes('patanjali') || lowerQuery.includes('biscuit') || lowerQuery.includes('बिस्किट') || lowerQuery.includes('ਬਿਸਕੁਟ')) {
            productKeyFound = "patanjali biscuit";
        } else if (lowerQuery.includes('bajaj') || lowerQuery.includes('bulb') || lowerQuery.includes('बलिया') || lowerQuery.includes('ਬਲਬ') || lowerQuery.includes('బల్బ్')) {
            productKeyFound = "bajaj bulb";
        } else if (lowerQuery.includes('kitkat') || lowerQuery.includes('chocolate') || lowerQuery.includes('चॉकलेट') || lowerQuery.includes('ਚਾਕਲੇਟ') || lowerQuery.includes('చాక్లెట్')) {
            productKeyFound = "kitkat chocolate";
        } else if (lowerQuery.includes('cement') || lowerQuery.includes('ambuja') || lowerQuery.includes('सीमेंट') || lowerQuery.includes('ਸੀਮੈਂਟ') || lowerQuery.includes('సిమెంట్')) {
            productKeyFound = "ambuja cement";
        }

        if (productKeyFound && bisDatabase[productKeyFound]) {
            const prod = bisDatabase[productKeyFound][selectedLang] || bisDatabase[productKeyFound]['en'];
            const responseHTML = `
                <b>Product Name:</b> ${prod.productName}<br><br>
                • <b>Manufacturer:</b> ${prod.manufacturer}<br>
                • <b>Applicable Standard:</b> ${prod.standard}<br>
                • <b>BIS License No:</b> <span style="color: #1a56b5; font-weight: bold;">${prod.licenseNumber}</span><br>
                • <b>Status:</b> <span style="color: #10b981; font-weight: bold;">${prod.status}</span> (Valid Upto: ${prod.validUpto})<br>
                • <b>Certification Scheme:</b> ${prod.mandatory}<br><br>
                • <b>Core Safety/Quality Parameters Tested:</b> ${prod.testingParams}<br><br>
                <i>Compliance Details:</i> ${prod.details}
            `;
            return res.json({ answer: responseHTML });
        }

        // 3. Certification Steps Matcher
        if (/(certif|licen[sc]e|apply|प्रमाण|सर्टिफिकेट|ਸਰਟੀਫਿਕੇਟ|సర్టిఫికేషన్)/.test(lowerQuery)) {
            return res.json({ answer: responses.certification[selectedLang] });
        }

        // 4. Gold Hallmarking Matcher
        if (/(hallmark|jewel|gold|huid|हॉलमार्क|ਹਾਲਮਾਰਕ|హాల్‌మార్క్|సోనా)/.test(lowerQuery)) {
            return res.json({ answer: responses.hallmarking[selectedLang] });
        }

        // 5. Default Fallback
        return res.json({ answer: responses.fallback[selectedLang] });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ answer: "An internal server error occurred." });
    }
});

app.listen(PORT, () => {
    console.log(`✅ BIS Multilingual Backend Server running on http://localhost:${PORT}`);
    console.log(`Public: Check your Render dashboard for the live URL.`);
});