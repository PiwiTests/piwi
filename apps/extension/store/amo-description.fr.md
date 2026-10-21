Piwi Picker vous donne le locator Playwright à utiliser pour n’importe quel élément de la page que vous consultez. Chaque candidat est noté selon sa stabilité, puis exécuté sur la page telle qu’elle est, pour que celui en tête trouve exactement un élément. Parcourez un scénario en cliquant, l’extension écrit le test ; reproduisez un bug, elle écrit le test en échec et le rapport.

**Depuis le bouton de la barre d’outils, sur n’importe quelle page**

- **Choisir un élément** : les locators classés d’un élément, revérifiés sur la page, à copier seuls, en ligne d’action ou en assertion. Quand plusieurs éléments portent le même nom, limitez le locator à un parent stable.
- **Enregistrer** : clics, saisies et choix sur les pages d’un site, transformés en test TypeScript prêt à lancer. Les mots de passe ne sont jamais enregistrés.
- **Signaler un bug** : enregistrez les étapes, marquez ce qui ne va pas sur la page, et obtenez un test en échec, un rapport Markdown et un fichier .piwibug avec les erreurs de console et les requêtes en échec. **Rejouer un rapport de bug** repasse ses étapes dans un onglet.
- **Contrôle** : les éléments qu’aucun locator stable ne trouve seul, chacun avec un data-testid suggéré.
- **Multi-sélection**, **Assertions** et **Contexte IA** : le motif commun aux lignes d’une liste, des lignes expect(...) pour un élément, et un bloc décrivant un élément pour un agent de code.

**Dans les outils de développement du navigateur**

Les locators classés de l’élément sélectionné dans Éléments, une console de locators avec le verdict du mode strict, les éléments que vous nommez exportés en page object, des mocks réseau, une requête ralentie ou mise en échec, le viewport d’un projet Playwright et Sauvegarder la connexion pour les tests.

**Privé par défaut**

La sélection et l’enregistrement n’utilisent jamais le réseau. Rien n’est collecté, rien n’est envoyé.

**En option : connecter votre instance Piwi**

Piwi est un tableau de bord auto-hébergé pour les résultats Playwright. Reliée à votre instance (son adresse et une clé d’API, dans les réglages), l’extension met aussi en évidence les éléments de la page que vos tests atteignent, indique lesquelles de vos fonctions de test marchent dessus, et enregistre les parcours sous forme d’appels à ces fonctions. Elle lit votre instance et ne lui envoie qu’une chose : un rapport de bug, quand vous cliquez sur Envoyer dans l’aperçu qui montre exactement ce qui part.

**Autorisations**

- L’onglet affiché, seulement quand vous cliquez sur le bouton de l’extension ou utilisez le raccourci clavier.
- Un seul site, demandé quand vous lancez un enregistrement dessus, pour suivre vos actions d’une page à l’autre. Rien n’est accordé à l’installation.
- Les cookies de ce site, demandés seulement quand vous sauvegardez sa connexion pour vos tests : ils vont dans un fichier sur votre machine.
- L’adresse de votre instance Piwi, demandée quand vous enregistrez une connexion.

Piwi Picker parle anglais, français, allemand, espagnol et portugais du Brésil.

Documentation (en anglais) : [piwitests.dev/features/extension](https://piwitests.dev/features/extension)

Piwi n’est ni affilié à Microsoft Corporation, ni approuvé ou soutenu par elle. Playwright est une marque de Microsoft Corporation.
