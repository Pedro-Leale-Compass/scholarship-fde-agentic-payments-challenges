import { useEffect, useState } from "react";
import Login from "./Login.js";
import Chat from "./Chat.js";
import { sair, usuarioAtual } from "./auth.js";

export default function App() {
  const [usuario, setUsuario] = useState<string | null>(null);
  const [verificando, setVerificando] = useState(true);

  useEffect(() => {
    usuarioAtual()
      .then(setUsuario)
      .finally(() => setVerificando(false));
  }, []);

  async function aoSair() {
    await sair();
    setUsuario(null);
  }

  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app-root">
        {verificando ? null : usuario ? (
          <Chat nome={usuario} aoSair={aoSair} />
        ) : (
          <Login aoEntrar={setUsuario} />
        )}
      </div>
    </>
  );
}