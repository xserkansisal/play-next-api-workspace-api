export interface UserProfileName {
  firstName: string;
  lastName: string;
}

function capitalizeFirstCharacter(value: string): string {
  const [firstCharacter, ...remainingCharacters] = Array.from(value);
  return firstCharacter ? `${firstCharacter.toUpperCase()}${remainingCharacters.join("")}` : "";
}

export function deriveUserProfileName(email: string): UserProfileName {
  const localPart = email.split("@", 1)[0] ?? "";
  const parts = localPart
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(capitalizeFirstCharacter);

  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}
