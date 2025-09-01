import { useState, useCallback } from 'react'
import Sea from "./components/Sea"
import SplitText from "./components/SplitText"
import "./App.css"

const App = () => {
  const [finish, setFinish] = useState(false)
  const onLetterAnimationComplete = useCallback(() => setFinish(true), [])

  return (
    <>
      <div className="user">
        <SplitText className="text" text="周杰" onLetterAnimationComplete={onLetterAnimationComplete} />
        <br />
        {finish && <SplitText className="desc" text="流水不争先，争的是滔滔不绝" />}
      </div>
      <Sea />
    </>
  )
}

export default App