const FIRST_NAMES = [
  "Alex", "Blake", "Casey", "Drew", "Evan", "Finley", "Harper", "Jordan",
  "Kai", "Logan", "Morgan", "Noah", "Parker", "Quinn", "Riley", "Taylor"
];

const LAST_NAMES = [
  "Adams", "Bennett", "Carter", "Davis", "Evans", "Foster", "Gray", "Hayes",
  "Irwin", "James", "Knight", "Lewis", "Miller", "Norris", "Perry", "Reed"
];

export function createAccount(config = {}) {
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const birthDate = generateBirthDate();
  const password = config.randomPassword === false
    ? String(config.specifiedPassword || "")
    : generatePassword();
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    age: calculateAge(birthDate),
    birthDate: formatBirthDate(birthDate),
    password,
    emailAddress: "",
    mobile: "",
    smsVerificationCode: "",
    emailVerificationCode: ""
  };
}

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const symbols = "!@#$%";
  let value = "";
  for (let index = 0; index < 10; index += 1) {
    value += alphabet[randomInt(0, alphabet.length - 1)];
  }
  return `${value}${symbols[randomInt(0, symbols.length - 1)]}${randomInt(10, 99)}`;
}

function pick(items) {
  return items[randomInt(0, items.length - 1)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateBirthDate() {
  const now = new Date();
  const oldest = new Date(now);
  oldest.setFullYear(now.getFullYear() - 38);
  const youngest = new Date(now);
  youngest.setFullYear(now.getFullYear() - 21);
  return new Date(randomInt(oldest.getTime(), youngest.getTime()));
}

function calculateAge(birthDate) {
  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const hasBirthdayPassed = now.getMonth() > birthDate.getMonth()
    || (now.getMonth() === birthDate.getMonth() && now.getDate() >= birthDate.getDate());
  if (!hasBirthdayPassed) {
    age -= 1;
  }
  return age;
}

function formatBirthDate(birthDate) {
  const year = String(birthDate.getFullYear());
  const month = String(birthDate.getMonth() + 1).padStart(2, "0");
  const day = String(birthDate.getDate()).padStart(2, "0");
  return {
    year,
    month,
    day,
    value: `${year}-${month}-${day}`
  };
}
