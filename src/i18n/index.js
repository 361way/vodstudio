import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

const getInitialLanguage = () => 'zh';

const resources = {
    zh: { translation: {} },
    en: { translation: en }
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: getInitialLanguage(),
        fallbackLng: 'zh',
        interpolation: { escapeValue: false },
        returnEmptyString: false
    });

export default i18n;
