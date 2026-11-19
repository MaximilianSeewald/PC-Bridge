# PC-Bridge unter Windows testen

Voraussetzungen sind Node.js 22 oder neuer sowie Git für den EPOCH-Test. Der
Verbindungstest funktioniert auch ohne Git. Der Client bleibt als normaler Prozess
im Konsolenfenster geöffnet.

1. Öffne deine eigene private PC-Bridge-Site. Falls du sie noch nicht eingerichtet
   hast, folge der [Anleitung im Hauptordner](../README.md).
2. Wähle **Kopplungscode anzeigen** und kopiere den vollständigen Code aus dem
   Textfeld. Ein neuer Code ersetzt die bisherige Kopplung.
3. Starte **PC-Bridge.cmd** per Doppelklick. Füge den Code ein und drücke Enter.
   Die Konsole zeigt den Code beim Einfügen nicht an. Gib anschließend den
   vollständigen Pfad zur lokalen EPOCH-Kopie ein. Für einen reinen
   Verbindungstest kannst du die Pfadangabe überspringen.
4. Öffne in ChatGPT im Web einen neuen **Work**-Chat. Installiere und verbinde
   **PC-Bridge** bei Bedarf unter **Plugins → Persönlich → Von dir erstellt**.
5. Schreibe zuerst „@PC-Bridge Prüfe die Verbindung zu meinem PC.“ Der Chat
   sollte den Prüfwert anzeigen. Frage anschließend „@PC-Bridge Lies den
   lokalen EPOCH-Git-Status.“ Der Chat erhält Branch und Änderungszahlen.

Zum Beenden drückst du Strg+C oder schließt das Fenster. Nach rund zwölf Sekunden
ohne Lebenszeichen gilt der Client als offline. Wenn der Client gerade erst
geschlossen wurde, kann ein Aufruf zunächst die Zeitüberschreitung melden.
Mit **Kopplung aufheben** kannst du den bisherigen Gerätezugang widerrufen.

Der Git-Aufruf liest die lokal festgelegte Arbeitskopie. ChatGPT erhält keine
Dateinamen, Dateiinhalte oder lokalen Pfade. Der Kopplungscode wird während
des Laufs im Arbeitsspeicher gehalten. Behandle ihn wie ein Passwort.
