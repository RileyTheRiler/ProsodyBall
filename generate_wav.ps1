Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile("C:\Users\riley\Desktop\ProsodyBall-main\fixtures\audio-eval\rainbow_passage.wav")
$synth.Speak("When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors.")
$synth.Dispose()
