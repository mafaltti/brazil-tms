import { getRequestConfig } from "next-intl/server";

/**
 * next-intl "without i18n routing" mode: locale is fixed server-side (pt-BR is the only shipped
 * locale for MVP). Adding a locale later = add messages/<locale>.json + resolve from user
 * preference here (research §12).
 */
export default getRequestConfig(async () => {
  const locale = "pt-BR";
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
